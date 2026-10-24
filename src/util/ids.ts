import {
  INVITE_TOKEN_BYTES,
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  SHORT_ID_LENGTH,
  TOKEN_BYTES,
  WEBHOOK_SECRET_BYTES,
} from "../config/constants";

function randomFromAlphabet(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function generateRoomId(): string {
  return randomFromAlphabet(ROOM_ID_ALPHABET, ROOM_ID_LENGTH);
}

function prefixedId(prefix: string): string {
  return `${prefix}_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", SHORT_ID_LENGTH)}`;
}

/** 16 random lowercase-alphanumeric characters, unprefixed. */
export function generateShortId(): string {
  return randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);
}

export function generateMemberId(): string {
  return prefixedId("u");
}

export function generateAttachmentId(): string {
  return prefixedId("a");
}

export function generateMessageId(): string {
  return prefixedId("m");
}

export function generateDeliveryId(): string {
  return prefixedId("d");
}

function base64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function generateToken(): string {
  return randomBase64Url(TOKEN_BYTES);
}

/** The random half of a room invite; the prefix is added by the caller. */
export function generateInviteSecret(): string {
  return randomBase64Url(INVITE_TOKEN_BYTES);
}

/**
 * The key a member's webhook deliveries are signed with. Unlike a member
 * token it is stored in plain form, because the room has to sign with it.
 */
export function generateWebhookSecret(): string {
  return randomBase64Url(WEBHOOK_SECRET_BYTES);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
