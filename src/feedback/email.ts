import type { Env } from "../env";
import { logFailure } from "../util/log";
import type { FeedbackInput } from "./schema";

const FETCH_TIMEOUT_MS = 5000;

/** Where a note is sent, and who it comes from. */
export interface FeedbackMailbox {
  readonly from: string;
  readonly to: string;
}

/** A Resend message body, built and asserted on without sending anything. */
export interface FeedbackMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly reply_to?: string;
}

/**
 * One note as plain text. The subject never carries the visitor's words, so a
 * mailbox listing cannot leak what someone wrote; the body holds the note
 * itself, the page they were on and how to answer them.
 */
export function feedbackEmail(input: FeedbackInput, mailbox: FeedbackMailbox): FeedbackMail {
  const reply = input.contact ?? null;
  const lines = [
    input.message,
    "",
    "—",
    `Page: ${input.page ?? "not recorded"}`,
    reply ? `Reply to: ${reply}` : "Reply to: no reply address was left",
  ];
  const mail: FeedbackMail = {
    from: mailbox.from,
    to: [mailbox.to],
    subject: "Orsko feedback",
    text: lines.join("\n"),
  };
  return reply === null ? mail : { ...mail, reply_to: reply };
}

/**
 * Sends one note on, when a destination mailbox is configured. Storage is the
 * record of record: a provider that refuses is logged and never fails the
 * visitor's request.
 */
export async function notifyFeedback(env: Env, input: FeedbackInput): Promise<void> {
  const to = env.FEEDBACK_TO;
  if (!to || !env.RESEND_API_KEY) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(feedbackEmail(input, { from: env.MAGIC_LINK_FROM, to })),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) logFailure("feedback.email_rejected", { status: res.status });
  } catch (error: unknown) {
    logFailure("feedback.email_failed", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
