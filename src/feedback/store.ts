import { generateShortId } from "../util/ids";
import type { FeedbackInput } from "./schema";

/** One stored note, as the table holds it. */
export interface FeedbackRow {
  readonly id: string;
  readonly message: string;
  readonly contact: string | null;
  readonly page: string | null;
  readonly user_id: string | null;
  readonly created_at: number;
}

/** Writes one note and returns the row that was written. */
export async function insertFeedback(
  db: D1Database,
  input: FeedbackInput,
  context: { readonly userId: string | null; readonly now: number },
): Promise<FeedbackRow> {
  const row: FeedbackRow = {
    id: generateShortId(),
    message: input.message,
    contact: input.contact ?? null,
    page: input.page ?? null,
    user_id: context.userId,
    created_at: context.now,
  };
  await db
    .prepare(
      "INSERT INTO feedback (id, message, contact, page, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(row.id, row.message, row.contact, row.page, row.user_id, row.created_at)
    .run();
  return row;
}
