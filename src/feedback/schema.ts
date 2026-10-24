import { z } from "zod";
import { scrubPath } from "../analytics/events";
import { FEEDBACK_MESSAGE_MAX_CHARS } from "../config/constants";

/**
 * What the feedback page sends. Everything but the message is optional: a
 * visitor who leaves no address stays anonymous, and the page is only ever
 * kept in the scrubbed form, so a room id or an invite never reaches storage.
 */
export const FeedbackBody = z.strictObject({
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_CHARS),
  // The trim runs before the address check, as it does for sign-in email.
  contact: z.string().trim().max(254).pipe(z.email()).optional(),
  page: z
    .string()
    .max(512)
    .transform((path) => scrubPath(path))
    .optional(),
});

export type FeedbackInput = z.infer<typeof FeedbackBody>;
