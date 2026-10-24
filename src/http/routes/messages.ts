import { Hono } from "hono";
import type { Env } from "../../env";
import { postToRoom, readRoom, recordOutcome } from "../../rooms/actions";
import { OutcomeBody, PollQuery, PostMessageBody, RoomIdParam } from "../../validation/schemas";
import { bearerToken } from "../auth";
import { parseJsonBody } from "../body";
import { respondError, respondResult } from "../respond";

export const messagesApi = new Hono<{ Bindings: Env }>();

messagesApi.post("/:roomId/messages", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const parsed = await parseJsonBody(c, PostMessageBody);
  if (!parsed.ok) return respondError(c, parsed.code, parsed.message);
  const result = await postToRoom(c.env, id.data, bearerToken(c), parsed.value);
  return respondResult(c, result, 201);
});

messagesApi.get("/:roomId/messages", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const parsed = PollQuery.safeParse(c.req.query());
  if (!parsed.success)
    return respondError(c, "invalid_request", parsed.error.issues[0]?.message ?? "invalid query");
  const result = await readRoom(c.env, id.data, bearerToken(c), parsed.data);
  return respondResult(c, result);
});

messagesApi.put("/:roomId/outcome", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const parsed = await parseJsonBody(c, OutcomeBody);
  if (!parsed.ok) return respondError(c, parsed.code, parsed.message);
  const result = await recordOutcome(c.env, id.data, bearerToken(c), parsed.value.text);
  return respondResult(c, result);
});
