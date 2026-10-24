import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from "../config/constants";
import { hmacSha256Hex } from "../util/hmac";
import { generateToken, hashToken, timingSafeEqual } from "../util/ids";
import * as adb from "./db";

/** Decodes a cookie value, falling back to the raw text if it is not valid percent-encoding. */
function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("="))
      .map((part) => {
        const i = part.indexOf("=");
        return [part.slice(0, i), decodeCookieValue(part.slice(i + 1))];
      }),
  );
}

export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function stateCookie(value: string): string {
  return `${OAUTH_STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=${OAUTH_STATE_TTL_SECONDS}`;
}

export function clearStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0`;
}

/** Mints a session and returns the raw id; only its hash reaches D1. */
export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string,
  now: number,
): Promise<string> {
  const raw = generateToken();
  await adb.insertSession(db, { idHash: await hashToken(raw), userId, userAgent, now });
  return raw;
}

/** Resolves a raw cookie value to a user, sliding the expiry at most hourly. */
export async function resolveSession(
  db: D1Database,
  rawId: string,
  now: number = Date.now(),
): Promise<{ userId: string } | null> {
  if (!rawId) return null;
  const idHash = await hashToken(rawId);
  const row = await adb.findSession(db, idHash, now);
  if (!row) return null;
  const lastTouch = row.expires_at - SESSION_TTL_MS;
  if (now - lastTouch > SESSION_TOUCH_INTERVAL_MS)
    await adb.touchSession(db, idHash, now + SESSION_TTL_MS);
  return { userId: row.user_id };
}

export async function destroySession(db: D1Database, rawId: string): Promise<void> {
  if (rawId) await adb.deleteSession(db, await hashToken(rawId));
}

/**
 * Signs the OAuth state as `nonce.timestamp.mac`. The timestamp is inside the
 * signed payload, so a state cannot outlive its window even if the cookie
 * that carried it is replayed later with a longer `Max-Age`.
 */
export async function signState(
  secret: string,
  nonce: string,
  now: number = Date.now(),
): Promise<string> {
  const payload = `${nonce}.${now}`;
  return `${payload}.${await hmacSha256Hex(secret, payload)}`;
}

/**
 * The nonce from a state this secret signed within the last
 * OAUTH_STATE_TTL_SECONDS, or null: a bad shape, a bad signature, an
 * unreadable timestamp and a stale one are all the same answer.
 */
export async function verifyState(
  secret: string,
  signed: string,
  now: number = Date.now(),
): Promise<string | null> {
  const macAt = signed.lastIndexOf(".");
  if (macAt <= 0) return null;
  const payload = signed.slice(0, macAt);
  const mac = signed.slice(macAt + 1);
  if (!timingSafeEqual(mac, await hmacSha256Hex(secret, payload))) return null;
  const issuedAt = payload.lastIndexOf(".");
  if (issuedAt <= 0) return null;
  const issued = Number(payload.slice(issuedAt + 1));
  if (!Number.isFinite(issued)) return null;
  if (now - issued > OAUTH_STATE_TTL_SECONDS * 1000) return null;
  return payload.slice(0, issuedAt);
}
