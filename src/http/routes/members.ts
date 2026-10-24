import type { Context } from "hono";
import { Hono } from "hono";
import { resolveIdentity } from "../../account/identity";
import { trackerFor } from "../../analytics/track";
import type { Env } from "../../env";
import { joinRoom, leaveRoom as leaveRoomAction, listMembers } from "../../rooms/actions";
import { JoinBody, MemberIdParam, RoomIdParam, WebhookBody } from "../../validation/schemas";
import { bearerToken } from "../auth";
import { parseJsonBody } from "../body";
import { respondError, respondResult } from "../respond";

export const membersApi = new Hono<{ Bindings: Env }>();

membersApi.post("/:roomId/members", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const parsed = await parseJsonBody(c, JoinBody);
  if (!parsed.ok) return respondError(c, parsed.code, parsed.message);
  // A key or session links the new member to an account; without one the
  // member is anonymous, exactly as before.
  const identity = await resolveIdentity(c);
  const result = await joinRoom(c.env, {
    roomId: id.data,
    name: parsed.value.name,
    role: parsed.value.role,
    webhookUrl: parsed.value.webhookUrl,
    invite: parsed.value.invite ?? null,
    userId: identity?.userId ?? null,
  });
  if (result.ok)
    trackerFor(c)(id.data, {
      name: "room_joined",
      params: { role: result.value.role, via: "http" },
    });
  return respondResult(c, result, 201);
});

membersApi.get("/:roomId/members", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const result = await listMembers(c.env, id.data, bearerToken(c));
  return respondResult(c, result);
});

membersApi.put("/:roomId/members/me/webhook", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const parsed = await parseJsonBody(c, WebhookBody);
  if (!parsed.ok) return respondError(c, parsed.code, parsed.message);
  const result = await c.env.ROOM.getByName(id.data).registerWebhook(
    bearerToken(c),
    parsed.value.url,
  );
  return respondResult(c, result);
});

membersApi.delete("/:roomId/members/me/webhook", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const result = await c.env.ROOM.getByName(id.data).removeWebhook(bearerToken(c));
  if (!result.ok) return respondError(c, result.code, result.message, result.retryAfterSeconds);
  return c.body(null, 204);
});

/** Leaving, however an agent spells it: all three routes end here. */
async function leave(c: Context<{ Bindings: Env }>, memberId?: string): Promise<Response> {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const result = await leaveRoomAction(c.env, id.data, bearerToken(c), memberId);
  if (!result.ok) return respondError(c, result.code, result.message, result.retryAfterSeconds);
  return c.body(null, 204);
}

membersApi.post("/:roomId/leave", (c) => leave(c));

membersApi.delete("/:roomId/members/:memberId", (c) => {
  const raw = c.req.param("memberId");
  if (raw === "me") return leave(c);
  const memberId = MemberIdParam.safeParse(raw);
  if (!memberId.success) return respondError(c, "invalid_request", "invalid member id");
  return leave(c, memberId.data);
});
