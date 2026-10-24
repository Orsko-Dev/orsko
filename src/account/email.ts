import type { Env } from "../env";
import { AppError } from "../validation/errors";
import { renderMagicLinkEmail } from "./email-template";

const FETCH_TIMEOUT_MS = 5000;

/**
 * Matches a `Name <local@domain>` sender or a bare `local@domain` address —
 * enough to catch an empty, truncated, or malformed `MAGIC_LINK_FROM` before
 * it reaches Resend. Not a full RFC 5322 validator.
 */
const SENDER_SHAPE = /^(?:[^<>]+<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

/** True when `value` looks like a usable email sender (display-name or bare form). */
export function isValidSenderShape(value: string): boolean {
  return SENDER_SHAPE.test(value.trim());
}

/**
 * Sends one sign-in link through Resend, from the configured
 * `MAGIC_LINK_FROM` sender. Throws when the provider refuses. Callers must
 * gate on `emailReady(env)` first, which validates the sender's shape.
 */
export async function sendMagicLink(env: Env, to: string, link: string): Promise<void> {
  const { subject, html, text } = renderMagicLinkEmail(link, env.PUBLIC_BASE_URL);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAGIC_LINK_FROM,
      to: [to],
      subject,
      html,
      text,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new AppError("auth_unavailable", "email provider rejected the message");
}
