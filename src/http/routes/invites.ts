import type { Context } from "hono";
import { Hono } from "hono";
import { resolveIdentity, sameOriginRequest } from "../../account/identity";
import { mirrorIndexWrite } from "../../account/index-write";
import * as invites from "../../account/invite-index";
import { updateRoomState } from "../../account/room-index";
import {
  INVITE_MINT_LIMIT_PER_HOUR,
  INVITE_MINT_WINDOW_SECONDS,
  INVITE_TTL_MS,
} from "../../config/constants";
import type { Env } from "../../env";
import { mintInviteToken } from "../../room/privacy";
import { pasteSentenceFor } from "../../templates/agents";
import { generateShortId } from "../../util/ids";
import { nowMs } from "../../util/time";
import { InviteBody, InviteIdParam, PrivacyBody, RoomIdParam } from "../../validation/schemas";
import { parseJsonBody, readJsonBody } from "../body";
import { respondError } from "../respond";

export const invitesApi = new Hono<{ Bindings: Env }>();

/** The room id and the caller's user id, or the response that refuses them. */
type Caller =
  | { roomId: string; userId: string; response?: undefined }
  | { roomId?: undefined; userId?: undefined; response: Response };

/**
 * Every invite route is an account action on a room: it needs a valid room
 * id, a caller signed in through their browser, and a request that did not
 * arrive from another site. Ownership itself is checked by the room object,
 * which is the only authority on who created it.
 *
 * A personal API key is deliberately not enough. Minting an invite hands out
 * access to a private room and flipping `private` takes it away from
 * everyone, so a leaked key must not be able to do either — the same rule the
 * API-keys routes apply to themselves. Reading history with a key is
 * unaffected.
 */
async function caller(c: Context<{ Bindings: Env }>): Promise<Caller> {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return { response: respondError(c, "invalid_request", "invalid room id") };
  if (!sameOriginRequest(c))
    return { response: respondError(c, "forbidden", "cross-site request") };
  const identity = await resolveIdentity(c);
  if (!identity) return { response: respondError(c, "unauthorized", "sign in required") };
  if (identity.via !== "session")
    return {
      response: respondError(c, "unauthorized", "sign in with your browser to manage invites"),
    };
  return { roomId: id.data, userId: identity.userId };
}

/** How many invites one account may mint per hour; overridable for tests. */
function mintLimit(env: Env): number {
  const configured = Number(env.INVITE_MINT_LIMIT_PER_HOUR);
  return Number.isFinite(configured) && configured > 0 ? configured : INVITE_MINT_LIMIT_PER_HOUR;
}

invitesApi.post("/:roomId/invites", async (c) => {
  const who = await caller(c);
  if (who.response) return who.response;
  const parsed = await parseJsonBody(c, InviteBody, { allowEmpty: true });
  if (!parsed.ok) return respondError(c, parsed.code, parsed.message);

  const limiter = c.env.IP_LIMITER.getByName(`invites:${who.userId}`);
  const gate = await limiter.hit({
    limit: mintLimit(c.env),
    windowSeconds: INVITE_MINT_WINDOW_SECONDS,
  });
  if (!gate.allowed)
    return respondError(c, "rate_limited", "too many invites minted", gate.retryAfterSeconds);

  const now = nowMs();
  const inviteId = `inv_${generateShortId()}`;
  const expiresAt = now + INVITE_TTL_MS;
  const token = mintInviteToken();
  const tokenHash = await token.hash;
  // The room object is authoritative for both ownership and validation, so it
  // is written first; the D1 row is the account-side mirror behind it.
  const recorded = await c.env.ROOM.getByName(who.roomId).mintInvite(who.userId, {
    inviteId,
    tokenHash,
    expiresAt,
  });
  if (!recorded.ok) return respondError(c, recorded.code, recorded.message);
  // The invite already works. If the mirror row cannot be written the owner's
  // list will miss it until that is repaired, which is a smaller loss than
  // refusing a token the room has already accepted.
  await mirrorIndexWrite("invite.mint", who.roomId, () =>
    invites.insertInvite(c.env.DB, {
      inviteId,
      roomId: who.roomId,
      issuedByUserId: who.userId,
      tokenHash,
      label: parsed.value.label ?? null,
      addressedEmail: parsed.value.addressedEmail?.toLowerCase() ?? null,
      // Logins are compared case-insensitively, so the address is stored the
      // way GitHub reports it back at sign-in.
      addressedGithubLogin: parsed.value.addressedGithubLogin?.toLowerCase() ?? null,
      createdAt: now,
      expiresAt,
    }),
  );
  return c.json(
    {
      inviteId,
      token: token.raw,
      expiresAt,
      pasteSentence: pasteSentenceFor(c.env.PUBLIC_BASE_URL, who.roomId, token.raw),
    },
    201,
  );
});

invitesApi.get("/:roomId/invites", async (c) => {
  const who = await caller(c);
  if (who.response) return who.response;
  // `canView` answers "owner" only for the creator, which is exactly who may
  // see the list. It is also how the room view decides to show the panel.
  const access = await c.env.ROOM.getByName(who.roomId).canView(who.userId, null);
  if (!access.ok) return respondError(c, access.code, access.message);
  if (access.value !== "owner")
    return respondError(c, "forbidden", "only the room's creator can do that");
  return c.json({ invites: await invites.listInvitesForRoom(c.env.DB, who.roomId, nowMs()) });
});

invitesApi.delete("/:roomId/invites/:inviteId", async (c) => {
  const who = await caller(c);
  if (who.response) return who.response;
  const inviteId = InviteIdParam.safeParse(c.req.param("inviteId"));
  if (!inviteId.success) return respondError(c, "invalid_request", "invalid invite id");
  const revoked = await c.env.ROOM.getByName(who.roomId).revokeInvite(who.userId, inviteId.data);
  if (!revoked.ok) return respondError(c, revoked.code, revoked.message);
  // The token has already stopped working; the stamp is the mirror of that.
  await mirrorIndexWrite("invite.revoke", who.roomId, () =>
    invites.markInviteRevoked(c.env.DB, inviteId.data, nowMs()),
  );
  return c.body(null, 204);
});

invitesApi.put("/:roomId/private", async (c) => {
  const who = await caller(c);
  if (who.response) return who.response;
  const body = await readJsonBody(c);
  if (!body.ok) return respondError(c, body.code, body.message);
  const parsed = PrivacyBody.safeParse(body.value);
  if (!parsed.success) return respondError(c, "invalid_request", "private must be true or false");
  const result = await c.env.ROOM.getByName(who.roomId).setPrivate(who.userId, parsed.data.private);
  if (!result.ok) return respondError(c, result.code, result.message);
  // The room has already flipped; the index row follows it.
  await mirrorIndexWrite("room.privacy", who.roomId, () =>
    updateRoomState(c.env.DB, who.roomId, { private: parsed.data.private }),
  );
  return c.body(null, 204);
});
