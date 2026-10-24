import {
  MAX_POLL_BATCH,
  MAX_STREAM_FRAME_BYTES,
  STREAM_CLOSE_ARCHIVED,
  STREAM_CLOSE_HELLO_TIMEOUT,
  STREAM_CLOSE_TOO_LARGE,
  STREAM_CLOSE_UNAUTHORIZED,
  STREAM_CLOSE_UNSUPPORTED_DATA,
  STREAM_REPLAY_MAX,
} from "../config/constants";
import { logEvent } from "../util/log";
import type { Result } from "../validation/errors";
import type { HelloInput, PostInput, ReadInput } from "../validation/frames";
import { parseClientFrame } from "../validation/frames";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";
import {
  acceptedAt,
  broadcastPresence,
  closeSocket,
  errorFrame,
  markAccepted,
  type SocketState,
  sendFrame,
  socketCountFor,
  socketState,
} from "./stream-socket";
import type { MembersResult, PostedMessage } from "./types";

/**
 * What the stream protocol needs from a RoomObject instance. Everything that
 * touches room state is a callback, so posting over a socket goes through the
 * very same guardrail, rate limit and append path as `POST /messages`.
 */
export interface StreamContext {
  readonly sql: SqlStorage;
  readonly ctx: DurableObjectState;
  /** How long a socket may stay unauthenticated before it is closed with 4408. */
  readonly helloTimeoutMs: number;
  room(): RoomRow | null;
  authenticate(token: string): Promise<Result<MemberRow>>;
  post(
    member: MemberRow,
    input: { text: string; attachmentIds: readonly string[] },
  ): Result<PostedMessage>;
  /** The presence list, optionally discounting a socket that is going away. */
  membersList(excluding?: WebSocket): MembersResult;
  markRead(memberId: string, since: number): void;
  /** The member ids still in the room, so a broadcast can skip the departed. */
  presentMemberIds(): ReadonlySet<string>;
  /** Records that the member acted, exactly as an authenticated HTTP call does. */
  touch(memberId: string): void;
  /** Now, in epoch milliseconds. Injected so the clock stays in one place. */
  now(): number;
}

/**
 * Answers the upgrade. The socket is accepted with no tags: tags can only be
 * set at accept time, and who the socket belongs to is not known until the
 * handshake, so membership is carried in the attachment instead.
 */
export function acceptStream(ctx: StreamContext): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.ctx.acceptWebSocket(server);
  // The accept time goes in the attachment, not in memory: it is what lets an
  // eviction-orphaned socket still be aged out after the object wakes.
  markAccepted(server, ctx.now());
  scheduleHelloTimeout(ctx, server);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Pending hello deadlines, keyed by socket so the entry disappears with the
 * socket itself. A timer holds the object awake, so it is cleared the moment
 * the handshake lands or the socket goes away.
 */
const helloTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

function scheduleHelloTimeout(ctx: StreamContext, ws: WebSocket): void {
  const timer = setTimeout(() => {
    helloTimers.delete(ws);
    if (socketState(ws) !== null) return;
    closeSocket(ws, STREAM_CLOSE_HELLO_TIMEOUT, "hello timeout");
  }, ctx.helloTimeoutMs);
  helloTimers.set(ws, timer);
}

function clearHelloTimeout(ws: WebSocket): void {
  const timer = helloTimers.get(ws);
  if (timer === undefined) return;
  clearTimeout(timer);
  helloTimers.delete(ws);
}

/**
 * Closes every other socket that is still unauthenticated past the grace
 * period. The hello timer lives in this isolate, so an object evicted before
 * it fires loses it; every wake-up sweeps instead, which re-establishes the
 * same deadline without any state that has to survive hibernation.
 */
function sweepUnauthenticated(ctx: StreamContext, current: WebSocket): void {
  const deadline = ctx.now() - ctx.helloTimeoutMs;
  for (const ws of ctx.ctx.getWebSockets()) {
    if (ws === current || socketState(ws) !== null) continue;
    const since = acceptedAt(ws);
    if (since === null || since > deadline) continue;
    closeSocket(ws, STREAM_CLOSE_HELLO_TIMEOUT, "hello timeout");
  }
}

function frameBytes(message: string | ArrayBuffer): number {
  return typeof message === "string"
    ? new TextEncoder().encode(message).byteLength
    : message.byteLength;
}

/** One client frame. Every expected failure answers with `error`, never throws. */
export async function handleMessage(
  ctx: StreamContext,
  ws: WebSocket,
  message: string | ArrayBuffer,
): Promise<void> {
  sweepUnauthenticated(ctx, ws);
  if (frameBytes(message) > MAX_STREAM_FRAME_BYTES) {
    sendFrame(
      ws,
      errorFrame("message_too_large", `frames are limited to ${MAX_STREAM_FRAME_BYTES} bytes`),
    );
    closeSocket(ws, STREAM_CLOSE_TOO_LARGE, "frame too large");
    return;
  }
  if (typeof message !== "string") {
    sendFrame(ws, errorFrame("invalid_request", "binary frames are not supported"));
    closeSocket(ws, STREAM_CLOSE_UNSUPPORTED_DATA, "text frames only");
    return;
  }
  const parsed = parseClientFrame(message);
  if (parsed.kind === "malformed") {
    sendFrame(ws, errorFrame("invalid_request", parsed.message));
    closeSocket(ws, STREAM_CLOSE_UNSUPPORTED_DATA, "malformed frame");
    return;
  }
  if (parsed.kind === "invalid") {
    sendFrame(ws, errorFrame("invalid_request", parsed.message, parsed.id));
    return;
  }
  await dispatch(ctx, ws, parsed.frame);
}

async function dispatch(
  ctx: StreamContext,
  ws: WebSocket,
  frame: HelloInput | PostInput | ReadInput,
): Promise<void> {
  const state = socketState(ws);
  if (frame.type === "hello") return handleHello(ctx, ws, frame, state);
  if (state === null) {
    sendFrame(ws, errorFrame("invalid_token", "send hello before any other frame"));
    closeSocket(ws, STREAM_CLOSE_UNAUTHORIZED, "not authenticated");
    return;
  }
  if (frame.type === "post") return handlePost(ctx, ws, frame, state);
  return handleRead(ctx, ws, frame, state);
}

async function handleHello(
  ctx: StreamContext,
  ws: WebSocket,
  frame: HelloInput,
  state: SocketState | null,
): Promise<void> {
  if (state !== null) {
    sendFrame(ws, errorFrame("invalid_request", "this socket has already said hello"));
    return;
  }
  const auth = await ctx.authenticate(frame.token);
  if (!auth.ok) {
    sendFrame(ws, errorFrame(auth.code, auth.message));
    closeSocket(ws, STREAM_CLOSE_UNAUTHORIZED, auth.code);
    return;
  }
  const row = ctx.room();
  if (!row) {
    sendFrame(ws, errorFrame("room_not_found", "room does not exist"));
    closeSocket(ws, STREAM_CLOSE_UNAUTHORIZED, "room_not_found");
    return;
  }
  const member = auth.value;
  const wasConnected = socketCountFor(ctx.ctx, member.member_id) > 0;
  ws.serializeAttachment({
    memberId: member.member_id,
    name: member.name,
    role: member.role,
  } satisfies SocketState);
  // The handshake landed, so the deadline timer has nothing left to guard and
  // must not hold the object awake for the rest of its window.
  clearHelloTimeout(ws);
  welcome(ctx, ws, row, member);
  logEvent("stream.hello", { roomId: row.room_id, memberId: member.member_id });
  // An archived room has nothing more to push and takes no posts: the client
  // is told what it joined and then let go.
  if (row.state === "archived") {
    closeSocket(ws, STREAM_CLOSE_ARCHIVED, "room archived");
    return;
  }
  if (frame.since !== undefined) replay(ctx, ws, row, frame.since);
  if (!wasConnected) broadcastPresence(ctx.ctx, ctx.membersList(), ctx.presentMemberIds());
}

function welcome(ctx: StreamContext, ws: WebSocket, row: RoomRow, member: MemberRow): void {
  const members = ctx.membersList();
  sendFrame(ws, {
    type: "welcome",
    roomId: row.room_id,
    you: { memberId: member.member_id, name: member.name, role: member.role },
    members: members.members,
    lastSeq: members.lastSeq,
    state: row.state,
  });
}

/**
 * Replays everything after the client's cursor, in order, as ordinary
 * `message` frames. Batched so a long room cannot build one huge array, and
 * capped at STREAM_REPLAY_MAX so one `hello` cannot push a whole room into a
 * single send buffer. A client that hits the cap is told where to continue.
 */
function replay(ctx: StreamContext, ws: WebSocket, row: RoomRow, since: number): void {
  let cursor = since;
  let sent = 0;
  while (sent < STREAM_REPLAY_MAX) {
    const limit = Math.min(MAX_POLL_BATCH, STREAM_REPLAY_MAX - sent);
    const batch = db.listMessagesSince(ctx.sql, row.room_id, cursor, limit);
    if (batch.length === 0) return;
    for (const message of batch) sendFrame(ws, { type: "message", message });
    sent += batch.length;
    cursor = batch.at(-1)?.seq ?? cursor;
  }
  if (db.listMessagesSince(ctx.sql, row.room_id, cursor, 1).length === 0) return;
  sendFrame(ws, {
    type: "replay_truncated",
    nextSince: cursor,
    lastSeq: (ctx.room() ?? row).next_seq - 1,
  });
}

/**
 * The member behind an authenticated socket, or null once they have left.
 * A socket outlives its membership: leaving is an HTTP call, and the socket
 * it was holding must stop being able to act the moment it lands.
 */
function currentMember(ctx: StreamContext, state: SocketState): MemberRow | null {
  const member = db.findMemberById(ctx.sql, state.memberId);
  if (member === null || member.left_at !== null) return null;
  // Acting over the socket is being seen, exactly as an authenticated HTTP
  // call is: this is the socket half of what `authenticate` does.
  ctx.touch(member.member_id);
  return member;
}

function handlePost(ctx: StreamContext, ws: WebSocket, frame: PostInput, state: SocketState): void {
  const member = currentMember(ctx, state);
  if (!member) {
    sendFrame(ws, errorFrame("invalid_token", "member is no longer in this room", frame.id));
    closeSocket(ws, STREAM_CLOSE_UNAUTHORIZED, "invalid_token");
    return;
  }
  const posted = ctx.post(member, { text: frame.text, attachmentIds: frame.attachmentIds });
  if (!posted.ok) {
    sendFrame(ws, errorFrame(posted.code, posted.message, frame.id, posted.retryAfterSeconds));
    return;
  }
  const { message, unread } = posted.value;
  sendFrame(ws, { type: "ack", id: frame.id, seq: message.seq, message, unread });
}

function handleRead(ctx: StreamContext, ws: WebSocket, frame: ReadInput, state: SocketState): void {
  if (!ctx.room()) {
    sendFrame(ws, errorFrame("room_not_found", "room does not exist"));
    return;
  }
  if (currentMember(ctx, state) === null) {
    sendFrame(ws, errorFrame("invalid_token", "member is no longer in this room"));
    closeSocket(ws, STREAM_CLOSE_UNAUTHORIZED, "invalid_token");
    return;
  }
  ctx.markRead(state.memberId, frame.since);
}

/** A socket going away: presence changes only when its member has none left. */
export function handleClose(ctx: StreamContext, ws: WebSocket, code: number): void {
  const state = socketState(ws);
  clearHelloTimeout(ws);
  sweepUnauthenticated(ctx, ws);
  // The peer has gone; close our half too so the object can hibernate and,
  // eventually, be evicted rather than held open by a half-closed socket.
  closeSocket(ws, code >= 1000 && code < 5000 ? code : 1000, "peer closed");
  const row = ctx.room();
  logEvent("stream.closed", {
    roomId: row?.room_id ?? "unknown",
    memberId: state?.memberId ?? "anonymous",
    code,
  });
  if (state === null || row === null) return;
  // The closing socket is still listed while this handler runs, so it is
  // discounted before deciding whether the member has gone offline.
  if (socketCountFor(ctx.ctx, state.memberId, ws) > 0) return;
  broadcastPresence(ctx.ctx, ctx.membersList(ws), ctx.presentMemberIds());
}
