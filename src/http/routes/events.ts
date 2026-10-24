import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PublicEventBody, toGa4Event, utcDay, visitorClientId } from "../../analytics/events";
import { postGa4Event } from "../../analytics/ga4";
import {
  EVENTS_LIMIT_PER_MINUTE,
  EVENTS_MAX_BODY_BYTES,
  EVENTS_WINDOW_SECONDS,
} from "../../config/constants";
import type { Env } from "../../env";
import { hashToken } from "../../util/ids";
import { nowMs } from "../../util/time";
import { clientIp } from "../auth";
import { parseJsonBody } from "../body";
import { respondError } from "../respond";

/**
 * POST /api/pulse — cookieless page-view and click counting for the public
 * pages (public/site.js). Same-origin only: it is kept out of the CORS
 * scopes in index.ts. The response never waits on Google.
 */
export const eventsApi = new Hono<{ Bindings: Env }>();

eventsApi.post(
  "/",
  bodyLimit({
    maxSize: EVENTS_MAX_BODY_BYTES,
    onError: (c) => respondError(c, "invalid_request", "event body too large"),
  }),
  async (c) => {
    const limiter = c.env.IP_LIMITER.getByName(`events:${await hashToken(clientIp(c))}`);
    const gate = await limiter.hit({
      limit: EVENTS_LIMIT_PER_MINUTE,
      windowSeconds: EVENTS_WINDOW_SECONDS,
    });
    if (!gate.allowed)
      return respondError(c, "rate_limited", "too many events", gate.retryAfterSeconds);

    const parsed = await parseJsonBody(c, PublicEventBody);
    if (!parsed.ok) return respondError(c, parsed.code, parsed.message);

    const measurementId = c.env.GA4_MEASUREMENT_ID;
    const apiSecret = c.env.GA4_API_SECRET;
    if (measurementId && apiSecret) {
      const event = toGa4Event(parsed.value, new URL(c.env.PUBLIC_BASE_URL).origin);
      const userAgent = c.req.header("user-agent") ?? "";
      c.executionCtx.waitUntil(
        visitorClientId(apiSecret, utcDay(nowMs()), clientIp(c), userAgent).then((clientId) =>
          postGa4Event({ measurementId, apiSecret }, clientId, event),
        ),
      );
    }
    return c.body(null, 204);
  },
);
