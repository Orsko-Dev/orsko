import { Hono } from "hono";
import { cors } from "hono/cors";
import { reconcile } from "./account/reconcile";
import type { Env } from "./env";
import { notFound } from "./http/not-found";
import { respondError } from "./http/respond";
import { attachmentsApi } from "./http/routes/attachments";
import { authRoutes, meRoot } from "./http/routes/auth";
import { avatarApi } from "./http/routes/avatar";
import { eventsApi } from "./http/routes/events";
import { feedbackApi } from "./http/routes/feedback";
import { invitesApi } from "./http/routes/invites";
import { lensProxy } from "./http/routes/lens";
import { meKeys, meRooms } from "./http/routes/me";
import { mediaRoutes } from "./http/routes/media";
import { membersApi } from "./http/routes/members";
import { messagesApi } from "./http/routes/messages";
import { roomPage } from "./http/routes/room-page";
import { roomsApi } from "./http/routes/rooms";
import { streamApi } from "./http/routes/stream";
import { mcpApi } from "./mcp/route";

export { IpLimiterObject } from "./limiter/IpLimiterObject";
export { RoomObject } from "./room/RoomObject";

const app = new Hono<{ Bindings: Env }>();

// Room and avatar endpoints are the public agent-facing surface and are
// deliberately cross-origin. Account routes are same-origin only: they carry
// the session cookie, so no CORS headers are offered for them.
for (const scope of ["/api/rooms/*", "/api/avatar/*"])
  app.use(
    scope,
    // A wildcard does not cover Authorization per the Fetch standard, so the
    // headers browser agents actually send are listed explicitly.
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-Filename", "X-Orsko-Key"],
    }),
  );

app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/api/me/keys", meKeys);
app.route("/api/me/rooms", meRooms);
app.route("/api/me", meRoot);
// Public-page measurement; same-origin only, so it sits outside the CORS scopes above.
app.route("/api/pulse", eventsApi);
// Feedback from the public page; same-origin only, like the measurement route.
app.route("/api/feedback", feedbackApi);
// PostHog's browser SDK, relayed through our own origin (ad-block lists block PostHog's domains).
app.route("/lens", lensProxy);
app.route("/api/rooms", roomsApi);
app.route("/api/rooms", membersApi);
app.route("/api/rooms", invitesApi);
app.route("/api/rooms", messagesApi);
app.route("/api/rooms", attachmentsApi);
app.route("/api/rooms", streamApi);
app.route("/api/avatar", avatarApi);
app.route("/mcp", mcpApi);
app.route("/media", mediaRoutes);
app.route("/", roomPage);

app.notFound(notFound);
app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", route: c.req.path, message: err.message }));
  return respondError(c, "internal", "internal error");
});

/**
 * The daily cron trigger reconciles the D1 room index against the room
 * objects themselves. It runs to completion in the background so the
 * handler returns immediately.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = (_event, env, ctx) => {
  ctx.waitUntil(reconcile(env));
};

export { app };
export default { fetch: app.fetch, scheduled };
