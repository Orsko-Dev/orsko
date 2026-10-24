import { API_KEY_PREFIX, KEY_TOUCH_INTERVAL_MS } from "../config/constants";
import { generateToken, hashToken } from "../util/ids";
import * as adb from "./db";

export function mintKey(): { raw: string; prefix: string } {
  const raw = `${API_KEY_PREFIX}${generateToken()}`;
  return { raw, prefix: raw.slice(0, 12) };
}

export async function keyHash(raw: string): Promise<string> {
  return hashToken(raw);
}

/**
 * Resolves a raw `X-Orsko-Key` header value to its owning user. `last_used_at`
 * is touched at most once per hour so an active key does not write to D1 on
 * every request.
 */
export async function resolveApiKey(
  db: D1Database,
  raw: string,
  now: number,
): Promise<{ userId: string } | null> {
  if (!raw.startsWith(API_KEY_PREFIX)) return null;
  const row = await adb.findApiKeyByHash(db, await hashToken(raw));
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > KEY_TOUCH_INTERVAL_MS)
    await adb.touchApiKey(db, row.id, now);
  return { userId: row.user_id };
}
