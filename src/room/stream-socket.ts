import { STREAM_CLOSE_ARCHIVED } from "../config/constants";
import { logEvent } from "../util/log";
import type { ErrorCode } from "../validation/errors";
import type { MemberRole, MembersResult, Message, RoomState } from "./types";

/**
 * What a room stream socket remembers about itself. It lives entirely in the
 * socket's attachment rather than in the object's memory, so the room may
 * hibernate with sockets open and still know who each one belongs to when it
 * wakes. `null` means the socket has not completed its handshake yet.
 */
export interface SocketState {
  readonly memberId: string;
  readonly name: string;
  readonly role: MemberRole;
}

/**
 * What an accepted socket carries before its handshake: when it was accepted,
 * so a socket orphaned by an eviction (its hello timer died with the object)
 * can still be aged out the next time the object wakes.
 */
export interface PendingState {
  readonly acceptedAt: number;
}

export type ServerFrame =
  | {
      readonly type: "welcome";
      readonly roomId: string;
      readonly you: SocketState;
      readonly members: MembersResult["members"];
      readonly lastSeq: number;
      readonly state: RoomState;
    }
  | { readonly type: "message"; readonly message: Message }
  | {
      readonly type: "replay_truncated";
      readonly nextSince: number;
      readonly lastSeq: number;
    }
  | { readonly type: "presence"; readonly members: MembersResult["members"] }
  | { readonly type: "state"; readonly state: RoomState }
  | {
      readonly type: "ack";
      readonly id: string;
      readonly seq: number;
      readonly message: Message;
      readonly unread: number;
    }
  | {
      readonly type: "error";
      readonly id?: string;
      readonly code: ErrorCode;
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

function isSocketState(value: unknown): value is SocketState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<SocketState>;
  return (
    typeof state.memberId === "string" &&
    typeof state.name === "string" &&
    (state.role === "agent" || state.role === "observer")
  );
}

function attachmentOf(ws: WebSocket): unknown {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

/** The member behind a socket, or null while it is still unauthenticated. */
export function socketState(ws: WebSocket): SocketState | null {
  const attached = attachmentOf(ws);
  return isSocketState(attached) ? attached : null;
}

/** Records when an unauthenticated socket was accepted. */
export function markAccepted(ws: WebSocket, now: number): void {
  try {
    ws.serializeAttachment({ acceptedAt: now } satisfies PendingState);
  } catch {
    // A socket the runtime has already torn down: nothing to remember.
  }
}

/**
 * When an unauthenticated socket was accepted, or null if it has said hello
 * or predates this bookkeeping.
 */
export function acceptedAt(ws: WebSocket): number | null {
  const attached = attachmentOf(ws);
  if (typeof attached !== "object" || attached === null) return null;
  const pending = (attached as Partial<PendingState>).acceptedAt;
  return typeof pending === "number" ? pending : null;
}

/**
 * Sends one frame. A socket the runtime has already torn down throws here;
 * that is expected rather than exceptional, so the socket is closed and the
 * caller carries on. Never throws.
 */
export function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    closeSocket(ws, 1011, "send failed");
  }
}

/** Closes one socket, tolerating a socket the runtime has already closed. */
export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already gone: nothing to close and nothing to report.
  }
}

export function errorFrame(
  code: ErrorCode,
  message: string,
  id?: string,
  retryAfterSeconds?: number,
): ServerFrame {
  return {
    type: "error",
    code,
    message,
    ...(id === undefined ? {} : { id }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/**
 * Pushes a frame to every handshaken socket. `present` is the set of member
 * ids still in the room: a socket whose member has left is skipped, so a
 * membership that has been revoked cannot keep reading the room even in the
 * moment before its socket is closed.
 */
function broadcast(
  ctx: DurableObjectState,
  frame: ServerFrame,
  present?: ReadonlySet<string>,
): void {
  for (const ws of ctx.getWebSockets()) {
    const state = socketState(ws);
    if (state === null) continue;
    if (present !== undefined && !present.has(state.memberId)) continue;
    sendFrame(ws, frame);
  }
}

/**
 * Closes every socket held by one member. Revoking a membership must reach
 * the sockets it minted: they outlive the token, and until they are closed
 * the room keeps being pushed to a member who has left.
 */
export function closeMemberSockets(
  ctx: DurableObjectState,
  memberId: string,
  code: number,
  reason: string,
): number {
  let closed = 0;
  for (const ws of ctx.getWebSockets()) {
    if (socketState(ws)?.memberId !== memberId) continue;
    closeSocket(ws, code, reason);
    closed += 1;
  }
  return closed;
}

/**
 * Every member id with at least one socket that finished its handshake, so
 * `connected` can be answered without any in-memory bookkeeping. `excluding`
 * drops a socket whose close handler is running.
 */
export function connectedMemberIds(
  ctx: DurableObjectState,
  excluding?: WebSocket,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const ws of ctx.getWebSockets()) {
    if (ws === excluding) continue;
    const state = socketState(ws);
    if (state !== null) ids.add(state.memberId);
  }
  return ids;
}

/**
 * How many handshaken sockets one member holds. `excluding` drops a socket
 * that is on its way out: a closing socket is still listed while its close
 * handler runs, and it must not count as presence.
 */
export function socketCountFor(
  ctx: DurableObjectState,
  memberId: string,
  excluding?: WebSocket,
): number {
  let count = 0;
  for (const ws of ctx.getWebSockets()) {
    if (ws !== excluding && socketState(ws)?.memberId === memberId) count += 1;
  }
  return count;
}

export function broadcastMessage(
  ctx: DurableObjectState,
  message: Message,
  present?: ReadonlySet<string>,
): void {
  broadcast(ctx, { type: "message", message }, present);
}

export function broadcastPresence(
  ctx: DurableObjectState,
  members: MembersResult,
  present?: ReadonlySet<string>,
): void {
  broadcast(ctx, { type: "presence", members: members.members }, present);
}

/**
 * Announces a lifecycle transition. An archived room has nothing more to
 * push, so its sockets are closed with 4410 right after the frame.
 */
export function broadcastState(
  ctx: DurableObjectState,
  roomId: string,
  state: RoomState,
  present?: ReadonlySet<string>,
): void {
  broadcast(ctx, { type: "state", state }, present);
  if (state !== "archived") return;
  for (const ws of ctx.getWebSockets()) {
    closeSocket(ws, STREAM_CLOSE_ARCHIVED, "room archived");
  }
  logEvent("stream.archived", { roomId });
}
