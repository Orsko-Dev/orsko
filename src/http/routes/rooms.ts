import type { Context } from "hono";
import { Hono } from "hono";
import { type Identity, resolveIdentity } from "../../account/identity";
import { trackerFor } from "../../analytics/track";
import { CREATE_LIMIT_PER_HOUR, CREATE_WINDOW_SECONDS } from "../../config/constants";
import type { Env } from "../../env";
import type { RoomObject } from "../../room/RoomObject";
import type { RoomMeta } from "../../room/types";
import { pasteSentenceFor } from "../../templates/agents";
import { renderTranscriptMarkdown } from "../../templates/transcript-markdown";
import { generateRoomId, hashToken } from "../../util/ids";
import { logEvent } from "../../util/log";
import { CreateRoomBody, RoomIdParam } from "../../validation/schemas";
import { bearerToken, clientIp } from "../auth";
import { parseJsonBody } from "../body";
import { respondError } from "../respond";

export const roomsApi = new Hono<{ Bindings: Env }>();

roomsApi.post("/", async (c) => {
  const limiter = c.env.IP_LIMITER.getByName(await hashToken(clientIp(c)));
  const gate = await limiter.hit({
    limit: CREATE_LIMIT_PER_HOUR,
    windowSeconds: CREATE_WINDOW_SECONDS,
  });
  if (!gate.allowed)
    return respondError(c, "create_rate_limited", "too many rooms created", gate.retryAfterSeconds);
  const parsed = await parseJsonBody(c, CreateRoomBody, { allowEmpty: true });
  if (!parsed.ok) return respondError(c, parsed.code, parsed.message);
  // Anonymous room creation is unchanged: an unidentified caller simply
  // creates a room that belongs to no account. A private room is the one
  // thing anonymity cannot buy — nobody would be able to issue its invites.
  const identity = await resolveIdentity(c);
  const wantsPrivate = parsed.value.private === true;
  if (wantsPrivate && !identity)
    return respondError(c, "invalid_request", "sign in to create a private room");
  const roomId = generateRoomId();
  const created = await c.env.ROOM.getByName(roomId).create({
    roomId,
    purpose: parsed.value.purpose ?? null,
    tier: "free",
    creatorUserId: identity?.userId ?? null,
    private: wantsPrivate,
  });
  if (!created.ok) return respondError(c, created.code, created.message);
  trackerFor(c)(roomId, { name: "room_created", params: { private: wantsPrivate } });
  return c.json(
    {
      roomId,
      url: `${c.env.PUBLIC_BASE_URL}/r/${roomId}`,
      createdAt: created.value.createdAt,
      private: created.value.private,
      // A private room has no sentence worth pasting until an invite is minted,
      // and the invite response carries that one.
      pasteSentence: wantsPrivate ? null : pasteSentenceFor(c.env.PUBLIC_BASE_URL, roomId),
    },
    201,
  );
});

/** Resolves the caller's identity at most once per request, however many checks ask. */
function identityOnce(c: Context<{ Bindings: Env }>): () => Promise<Identity | null> {
  let pending: Promise<Identity | null> | null = null;
  return () => {
    pending ??= resolveIdentity(c);
    return pending;
  };
}

/**
 * The same access rule as the browser view, for the API representations of a
 * private room. A member token is enough (that is how the room view reads its
 * own room), otherwise the caller must be the owner, a linked member, or hold
 * a usable invite. Returns null when the room is public or the caller passes.
 */
async function refusePrivate(
  c: Context<{ Bindings: Env }>,
  stub: DurableObjectStub<RoomObject>,
  isPrivate: boolean,
  identity: () => Promise<Identity | null>,
): Promise<Response | null> {
  if (!isPrivate) return null;
  const token = bearerToken(c);
  if (token) {
    const member = await stub.verifyToken(token);
    if (member.ok) return null;
  }
  const caller = await identity();
  const access = await stub.canView(caller?.userId ?? null, c.req.query("invite") ?? null);
  return access.ok ? null : respondError(c, access.code, access.message);
}

/**
 * Whether the caller owns the room, for the `viewer` field on a public
 * room's details. This runs for every viewer, signed in or not, so a D1
 * outage must not turn a public room's page into a 500: it degrades to "not
 * the owner" and logs the failure instead. Private-room access is gated
 * separately, by `refusePrivate`, and keeps failing loudly as it always has.
 */
async function isOwnerOrFallback(
  roomId: string,
  stub: DurableObjectStub<RoomObject>,
  identity: () => Promise<Identity | null>,
): Promise<boolean> {
  try {
    const caller = await identity();
    return caller === null ? false : await stub.isOwner(caller.userId);
  } catch (error: unknown) {
    logEvent("room.viewer_lookup_failed", {
      roomId,
      errorClass: error instanceof Error ? error.name : "unknown_error",
    });
    return false;
  }
}

roomsApi.get("/:roomId", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const stub = c.env.ROOM.getByName(id.data);
  const meta = await stub.getMeta();
  if (!meta) return respondError(c, "room_not_found", "room does not exist");
  const identity = identityOnce(c);
  const refused = await refusePrivate(c, stub, meta.private, identity);
  if (refused) return refused;
  const isOwner = await isOwnerOrFallback(id.data, stub, identity);
  return c.json({ ...meta, viewer: { isOwner } });
});

/**
 * The access rule for both transcript representations. An archived room
 * refuses joins, so no token can be minted for it; its transcript is readable
 * by anyone holding the room URL — unless the room is private, where the link
 * alone was never enough. A live or slow room still requires membership (an
 * observer token is enough). Returns the refusal, or null when the caller passes.
 */
async function refuseTranscript(
  c: Context<{ Bindings: Env }>,
  stub: DurableObjectStub<RoomObject>,
  meta: RoomMeta,
): Promise<Response | null> {
  const refused = await refusePrivate(c, stub, meta.private, identityOnce(c));
  if (refused) return refused;
  if (meta.state === "archived") return null;
  const auth = await stub.verifyToken(bearerToken(c));
  return auth.ok ? null : respondError(c, auth.code, auth.message);
}

roomsApi.get("/:roomId/transcript", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const stub = c.env.ROOM.getByName(id.data);
  const meta = await stub.getMeta();
  if (!meta) return respondError(c, "room_not_found", "room does not exist");
  const refused = await refuseTranscript(c, stub, meta);
  return refused ?? c.json({ messages: await stub.transcript() });
});

roomsApi.get("/:roomId/transcript.md", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const stub = c.env.ROOM.getByName(id.data);
  const meta = await stub.getMeta();
  if (!meta) return respondError(c, "room_not_found", "room does not exist");
  const refused = await refuseTranscript(c, stub, meta);
  if (refused) return refused;
  const exported = await stub.transcriptExport();
  if (!exported) return respondError(c, "room_not_found", "room does not exist");
  return c.text(renderTranscriptMarkdown(exported), 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="orsko-${id.data}.md"`,
  });
});
