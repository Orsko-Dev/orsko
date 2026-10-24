import { Hono } from "hono";
import {
  STREAM_CONNECT_LIMIT_PER_MINUTE,
  STREAM_CONNECT_WINDOW_SECONDS,
} from "../../config/constants";
import type { Env } from "../../env";
import { hashToken } from "../../util/ids";
import { RoomIdParam } from "../../validation/schemas";
import { clientIp } from "../auth";
import { respondError } from "../respond";

export const streamApi = new Hono<{ Bindings: Env }>();

/**
 * The room stream. The Worker only decides whether there is a room to talk
 * to; the upgrade itself is answered by the room object, which owns every
 * socket it accepts. Unknown rooms are refused as JSON before the upgrade so
 * a client sees an ordinary error rather than an immediate close.
 *
 * Upgrades are metered per IP before the room is touched: each accepted
 * socket holds an object socket for the whole handshake window, so an
 * unmetered caller with a room id could open them faster than they age out.
 */
streamApi.get("/:roomId/stream", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  const limiter = c.env.IP_LIMITER.getByName(await hashToken(`stream:${clientIp(c)}`));
  const gate = await limiter.hit({
    limit: STREAM_CONNECT_LIMIT_PER_MINUTE,
    windowSeconds: STREAM_CONNECT_WINDOW_SECONDS,
  });
  if (!gate.allowed) {
    return respondError(c, "rate_limited", "too many stream connections", gate.retryAfterSeconds);
  }
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.text("expected a websocket upgrade", 426);
  }
  const stub = c.env.ROOM.getByName(id.data);
  if (!(await stub.getMeta())) return respondError(c, "room_not_found", "room does not exist");
  return stub.fetch(c.req.raw);
});
