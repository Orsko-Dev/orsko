import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { resolveIdentity } from "../../account/identity";
import {
  FEEDBACK_LIMIT_PER_HOUR,
  FEEDBACK_MAX_BODY_BYTES,
  FEEDBACK_WINDOW_SECONDS,
} from "../../config/constants";
import type { Env } from "../../env";
import { notifyFeedback } from "../../feedback/email";
import { FeedbackBody } from "../../feedback/schema";
import { insertFeedback } from "../../feedback/store";
import { hashToken } from "../../util/ids";
import { logEvent } from "../../util/log";
import { nowMs } from "../../util/time";
import { detectSecrets, secretRejectionMessage } from "../../validation/secrets";
import { clientIp } from "../auth";
import { parseJsonBody } from "../body";
import { respondError } from "../respond";

/**
 * POST /api/feedback — what a visitor types on the feedback page. Same-origin
 * only: it is kept out of the CORS scopes in index.ts. Signing in is never
 * required, and a note with no reply address stays anonymous. The row in D1 is
 * the record; the email notification is best-effort behind it.
 */
export const feedbackApi = new Hono<{ Bindings: Env }>();

feedbackApi.post(
  "/",
  bodyLimit({
    maxSize: FEEDBACK_MAX_BODY_BYTES,
    onError: (c) => respondError(c, "invalid_request", "feedback body too large"),
  }),
  async (c) => {
    const limiter = c.env.IP_LIMITER.getByName(`feedback:${await hashToken(clientIp(c))}`);
    const gate = await limiter.hit({
      limit: FEEDBACK_LIMIT_PER_HOUR,
      windowSeconds: FEEDBACK_WINDOW_SECONDS,
    });
    if (!gate.allowed)
      return respondError(
        c,
        "rate_limited",
        "too much feedback too quickly",
        gate.retryAfterSeconds,
      );

    const parsed = await parseJsonBody(c, FeedbackBody);
    if (!parsed.ok) return respondError(c, parsed.code, parsed.message);

    // A visitor pasting a log or a config into the box must not leave a live
    // credential in our database or our inbox. The kinds are logged, never the text.
    const secrets = detectSecrets(parsed.value.message);
    if (secrets.length > 0) {
      logEvent("feedback.secret_detected", { kinds: secrets.map((hit) => hit.kind).join(",") });
      return respondError(c, "secret_detected", secretRejectionMessage(secrets));
    }

    const identity = await resolveIdentity(c);
    const row = await insertFeedback(c.env.DB, parsed.value, {
      userId: identity?.userId ?? null,
      now: nowMs(),
    });
    logEvent("feedback.received", {
      id: row.id,
      page: row.page,
      withContact: row.contact !== null,
      signedIn: row.user_id !== null,
    });
    c.executionCtx.waitUntil(notifyFeedback(c.env, parsed.value));
    return c.body(null, 204);
  },
);
