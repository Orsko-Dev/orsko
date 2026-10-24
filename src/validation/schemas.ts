import { z } from "zod";
import {
  FALLBACK_CONTENT_TYPE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILENAME_CHARS,
  MAX_INVITE_LABEL_CHARS,
  MAX_INVITE_TOKEN_CHARS,
  MAX_OUTCOME_CHARS,
  MAX_PURPOSE_CHARS,
  MAX_WAIT_SECONDS,
  MAX_WEBHOOK_URL_CHARS,
  MEMBER_NAME_PATTERN,
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  SYSTEM_SENDER,
} from "../config/constants";
import { webhookUrlProblem } from "./webhook-url";

const roomIdPattern = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);
const prefixedId = (prefix: string) => new RegExp(`^${prefix}_[a-z0-9]{16}$`);

export const RoomIdParam = z.string().regex(roomIdPattern, "invalid room id");
export const AttachmentIdParam = z.string().regex(prefixedId("a"), "invalid attachment id");
export const ApiKeyIdParam = z.string().regex(prefixedId("key"), "invalid key id");
export const InviteIdParam = z.string().regex(prefixedId("inv"), "invalid invite id");
export const MemberIdParam = z.string().regex(prefixedId("u"), "invalid member id");

/**
 * Sign-in requests carry only an address; 254 is the RFC 5321 maximum. The
 * trim has to run before the email check (not after, as `z.email().trim()`
 * would), or a padded address like " bob@example.com " fails validation
 * before the trim ever gets a chance to run.
 */
export const SigninEmailBody = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
});

/** A personal API key is created with a short human label, never a secret. */
export const CreateApiKeyBody = z.object({
  label: z.string().trim().min(1).max(60),
});

export const CreateRoomBody = z.object({
  purpose: z.string().trim().min(1).max(MAX_PURPOSE_CHARS).optional(),
  /** Only a signed-in caller may ask for this; the route enforces that. */
  private: z.boolean().optional(),
});

/** An invite is addressed to at most one person, and labelled for the owner. */
export const InviteBody = z.object({
  addressedEmail: z.string().trim().max(254).pipe(z.email()).optional(),
  addressedGithubLogin: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,39}$/, "invalid GitHub login")
    .optional(),
  label: z.string().trim().min(1).max(MAX_INVITE_LABEL_CHARS).optional(),
});

export const PrivacyBody = z.object({ private: z.boolean() });

/**
 * A webhook target, checked at the Worker boundary. The room fetches this
 * url from inside our network, so the rules in `webhookUrlProblem` are a
 * security control, not a convenience: see that module for what they block.
 */
export const WebhookUrlField = z
  .string()
  .max(MAX_WEBHOOK_URL_CHARS, `webhookUrl must be at most ${MAX_WEBHOOK_URL_CHARS} characters`)
  .superRefine((url, ctx) => {
    const problem = webhookUrlProblem(url);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

export const JoinBody = z
  .object({
    name: z
      .string()
      .regex(MEMBER_NAME_PATTERN, "name must be 1-32 chars of letters, digits, dash, underscore")
      .refine((n) => n.toLowerCase() !== SYSTEM_SENDER, "name is reserved"),
    role: z.enum(["agent", "observer"]).default("agent"),
    webhookUrl: WebhookUrlField.optional(),
    // Required by a private room, ignored by a public one.
    invite: z.string().trim().min(1).max(MAX_INVITE_TOKEN_CHARS).optional(),
  })
  // An observer cannot post, and so has nothing to be woken for.
  .refine((b) => b.role !== "observer" || b.webhookUrl === undefined, {
    message: "an observer cannot register a webhookUrl",
  });

export const WebhookBody = z.object({ url: WebhookUrlField });

export const PostMessageBody = z.object({
  text: z.string().min(1),
  attachmentIds: z.array(AttachmentIdParam).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
});

/** What a session decided and left open. Trimmed, so whitespace alone is empty. */
export const OutcomeBody = z.object({
  text: z.string().trim().min(1).max(MAX_OUTCOME_CHARS),
});

export const PollQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  waitSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(MAX_WAIT_SECONDS)
    .transform((n) => Math.min(n, MAX_WAIT_SECONDS)),
});

// Control characters would let a filename smuggle line breaks into the
// Content-Disposition header we echo back on download. Checked by code point
// rather than a regex, which may not contain control characters.
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const SafeFilename = z
  .string()
  .min(1)
  .max(MAX_FILENAME_CHARS)
  .refine(
    (f) => !f.includes("/") && !f.includes("\\") && !f.includes("..") && !hasControlChar(f),
    "unsafe filename",
  );

export const UploadHeaders = z
  .object({
    "x-filename": SafeFilename,
    "content-length": z.coerce.number().int().min(1),
    "content-type": z.string().optional(),
  })
  .transform((h) => ({
    filename: h["x-filename"],
    size: h["content-length"],
    contentType: h["content-type"]?.split(";")[0]?.trim() || FALLBACK_CONTENT_TYPE,
  }));

export type CreateRoomInput = z.infer<typeof CreateRoomBody>;
export type InviteInput = z.infer<typeof InviteBody>;
export type JoinInput = z.infer<typeof JoinBody>;
export type WebhookInput = z.infer<typeof WebhookBody>;
export type PostMessageInput = z.infer<typeof PostMessageBody>;
export type PollInput = z.infer<typeof PollQuery>;
export type UploadInput = z.infer<typeof UploadHeaders>;
