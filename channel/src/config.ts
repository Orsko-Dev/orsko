import path from "node:path";

/** Kept in sync with the Worker's `src/config/constants.ts`. */
export const ROOM_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const ROOM_ID_LENGTH = 12;
export const MEMBER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_BASE_URL = "https://orsko.dev";

/** Long-poll and injection tuning. All milliseconds unless the name says otherwise. */
export const POLL_WAIT_SECONDS = 25;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const RESEND_AFTER_MS = 60_000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Longest outcome the room accepts, in characters; mirrors the Worker's MAX_OUTCOME_CHARS. */
export const MAX_OUTCOME_CHARS = 2000;
export const RECENT_ON_JOIN_SHOWN = 10;

/** Stream tuning. The socket is the primary transport; long-poll is the fallback. */
export const STREAM_BACKOFF_MIN_MS = 1_000;
export const STREAM_BACKOFF_MAX_MS = 30_000;
export const POST_ACK_TIMEOUT_MS = 10_000;
/**
 * The largest `post` frame the channel will put on the socket. The room's
 * WebSocket rejects oversized frames by closing the connection, which would
 * take the whole room down for one long reply, so anything over this goes to
 * HTTP instead.
 */
export const MAX_STREAM_FRAME_BYTES = 65_536;
/**
 * A welcomed session that closes sooner than this was not a working session:
 * it counts towards the fallback threshold, so a server that accepts sockets
 * and drops them at 1 Hz ends up on long-poll rather than replaying the room
 * once a second forever.
 */
export const STREAM_FLAP_WINDOW_MS = 5_000;
/** Consecutive failed connects before the long-poll fallback takes over. */
export const STREAM_FALLBACK_AFTER_FAILURES = 3;
/** How often to try the socket again while the fallback is carrying the room. */
export const STREAM_FALLBACK_RETRY_MS = 60_000;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface RoomLocation {
  readonly roomId: string;
  readonly baseUrl: string;
}

export interface ChannelConfig extends RoomLocation {
  readonly roomLink: string;
  readonly name: string;
  readonly stateDir: string;
  /**
   * A personal Orsko API key, sent as `X-Orsko-Key` when joining so the room
   * is linked to that account's history. Optional, and never logged.
   */
  readonly apiKey?: string;
  /** A single-use invite for a private room, sent in the join body. */
  readonly invite?: string;
}

function isRoomId(value: string): boolean {
  if (value.length !== ROOM_ID_LENGTH) return false;
  for (const ch of value) {
    if (!ROOM_ID_ALPHABET.includes(ch)) return false;
  }
  return true;
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Origin of a full room link, or null when the input is not an absolute URL. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Accepts a full room URL, a bare `/r/<id>` path, or a bare room id. Mirrors
 * the landing page parser so a link pasted from either place behaves the same.
 */
export function parseRoomLocation(input: string): RoomLocation | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const withoutTail = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const match = withoutTail.match(/(?:^|\/)r\/([^/]+)$/);
  const roomId = match?.[1] ?? withoutTail;
  if (!isRoomId(roomId)) return null;
  const origin = match ? originOf(withoutTail) : null;
  return { roomId, baseUrl: origin ?? DEFAULT_BASE_URL };
}

/** The room's stream endpoint: the API path under a ws(s) scheme. */
export function streamUrlFor(baseUrl: string, roomId: string): string {
  const url = new URL(`${trimBaseUrl(baseUrl)}/api/rooms/${roomId}/stream`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function readBaseUrlOverride(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const origin = originOf(raw.trim());
  if (!origin) throw new ConfigError("ORSKO_BASE_URL must be an http(s) URL");
  return trimBaseUrl(origin);
}

function readName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) throw new ConfigError("ORSKO_NAME is required (1-32 chars of A-Z a-z 0-9 _ -)");
  if (!MEMBER_NAME_PATTERN.test(name))
    throw new ConfigError("ORSKO_NAME must be 1-32 characters of A-Z a-z 0-9 _ -");
  return name;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** A trimmed optional secret, or null when the variable is absent or blank. */
function readOptionalSecret(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  return value === "" ? null : value;
}

/** Reads the channel's environment. Throws `ConfigError` with a fixable message. */
export function loadConfig(env: EnvLike, homeDir: string): ChannelConfig {
  const room = (env.ORSKO_ROOM ?? "").trim();
  if (!room)
    throw new ConfigError("ORSKO_ROOM is required (a room link such as https://orsko.dev/r/<id>)");
  const location = parseRoomLocation(room);
  if (!location) throw new ConfigError(`ORSKO_ROOM is not a room link or room id: ${room}`);
  const override = readBaseUrlOverride(env.ORSKO_BASE_URL);
  const baseUrl = override ?? trimBaseUrl(location.baseUrl);
  const stateDir = (env.ORSKO_STATE_DIR ?? "").trim() || path.join(homeDir, ".orsko", "rooms");
  const apiKey = readOptionalSecret(env.ORSKO_API_KEY);
  const invite = readOptionalSecret(env.ORSKO_INVITE);
  return {
    roomId: location.roomId,
    baseUrl,
    roomLink: `${baseUrl}/r/${location.roomId}`,
    name: readName(env.ORSKO_NAME),
    stateDir,
    ...(apiKey === null ? {} : { apiKey }),
    ...(invite === null ? {} : { invite }),
  };
}
