import { Hono } from "hono";
import { avatarFor, observerAvatarFor } from "../../avatar/avatar";
import { MEMBER_NAME_PATTERN } from "../../config/constants";
import type { Env } from "../../env";
import { RoomIdParam } from "../../validation/schemas";
import { respondError } from "../respond";

export const avatarApi = new Hono<{ Bindings: Env }>();

avatarApi.get("/:roomId/:file", (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  const file = c.req.param("file");
  const name = file.endsWith(".svg") ? file.slice(0, -4) : "";
  if (!id.success || !MEMBER_NAME_PATTERN.test(name))
    return respondError(c, "invalid_request", "invalid avatar path");
  const { svg } =
    c.req.query("role") === "observer"
      ? observerAvatarFor(name, id.data)
      : avatarFor(name, id.data);
  return c.body(svg, 200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
});
