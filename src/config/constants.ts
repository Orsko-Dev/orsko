export const ROOM_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const ROOM_ID_LENGTH = 12;
export const SHORT_ID_LENGTH = 16;
export const TOKEN_BYTES = 32;

export const DEFAULT_WAIT_SECONDS = 25;
export const MAX_WAIT_SECONDS = 25;
export const SLOW_MODE_RETRY_SECONDS = 30;
export const MAX_POLL_BATCH = 200;

// How many prior messages a joining member sees immediately, so an agent can
// read what already happened before it posts anything.
export const RECENT_MESSAGES_ON_JOIN = 20;

export const CREATE_LIMIT_PER_HOUR = 30;
export const CREATE_WINDOW_SECONDS = 3600;

/**
 * How many stream upgrades one IP may ask for per minute. An upgrade is cheap
 * for the client and holds an object socket for the whole handshake window,
 * so it is metered by the same limiter that guards room creation.
 */
export const STREAM_CONNECT_LIMIT_PER_MINUTE = 60;
export const STREAM_CONNECT_WINDOW_SECONDS = 60;

export const MEMBER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const OBSERVER_NAME_PREFIX = "viewer-";
export const SYSTEM_SENDER = "system";

// Observers do not count toward the tier member limit, so they need their own
// bound: each one holds a token and a row, and the browser view mints one per
// page load. Not tier-specific.
export const MAX_OBSERVERS_PER_ROOM = 20;

export const MAX_PURPOSE_CHARS = 500;
export const MAX_WEBHOOK_URL_CHARS = 2048;
/** An invite token is `orsko_inv_` plus 24 base64url bytes; 200 leaves room. */
export const MAX_INVITE_TOKEN_CHARS = 200;
/** Prefix on every minted room invite, before the random token. */
export const INVITE_TOKEN_PREFIX = "orsko_inv_";
/** 24 bytes base64url is 32 characters, with no padding to strip. */
export const INVITE_TOKEN_BYTES = 24;
/** How long a freshly minted invite stays usable. Single use besides. */
export const INVITE_TTL_MS = 7 * 86_400_000;
/** Longest label an owner may attach to an invite for their own reference. */
export const MAX_INVITE_LABEL_CHARS = 60;
/**
 * How many invites one account may mint per hour, across all its rooms.
 * Overridable through `env.INVITE_MINT_LIMIT_PER_HOUR` so tests need not
 * mint thirty of them, as `STREAM_HELLO_TIMEOUT_MS` is for the handshake.
 */
export const INVITE_MINT_LIMIT_PER_HOUR = 30;
export const INVITE_MINT_WINDOW_SECONDS = 3600;
export const WEBHOOK_SECRET_BYTES = 32;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/**
 * How long to wait before each retry of a failed delivery. One attempt is
 * made immediately, so a webhook is tried WEBHOOK_MAX_ATTEMPTS times in all
 * and is disabled when the last of them fails.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
/** Deliveries attempted in one pass, so a large backlog cannot stall the actor. */
export const WEBHOOK_DELIVERY_BATCH = 50;
export const MAX_FILENAME_CHARS = 255;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export const SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/zip",
  "application/gzip",
  "application/x-tar",
]);
export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * How long a stream socket may stay unauthenticated. The client must send
 * its `hello` frame within this window or the server closes it with 4408.
 * Overridable through `env.STREAM_HELLO_TIMEOUT_MS` so tests need not wait.
 */
export const STREAM_HELLO_TIMEOUT_MS = 10_000;
/**
 * How many messages one `hello` may replay. A room holds up to a tier's
 * maxMessages, each up to 32 KiB, so an uncapped `since: 0` would push the
 * lot into one send buffer inside a single handler. Past the cap the client
 * gets a `replay_truncated` frame carrying the cursor to continue from.
 */
export const STREAM_REPLAY_MAX = 200;
/** Largest client frame the room will read, in bytes. Larger closes 1009. */
export const MAX_STREAM_FRAME_BYTES = 64 * 1024;
/** Longest client-chosen correlation id echoed back on `ack` and `error`. */
export const MAX_STREAM_CLIENT_ID_CHARS = 128;

/** WebSocket close codes the room uses beyond the standard ones. */
export const STREAM_CLOSE_UNAUTHORIZED = 4401;
export const STREAM_CLOSE_HELLO_TIMEOUT = 4408;
export const STREAM_CLOSE_ARCHIVED = 4410;
export const STREAM_CLOSE_UNSUPPORTED_DATA = 1003;
export const STREAM_CLOSE_TOO_LARGE = 1009;

/** Name of the browser session cookie. Its value is the raw session id. */
export const SESSION_COOKIE = "orsko_session";
/** Name of the short-lived cookie holding the signed OAuth state nonce. */
export const OAUTH_STATE_COOKIE = "orsko_oauth_state";
/** How long a session lives, sliding on use. Matches the D1 session row. */
export const SESSION_TTL_MS = 30 * 86_400_000;
/**
 * A session is only slid forward once an hour, so a busy browser does not
 * write to D1 on every request.
 */
export const SESSION_TOUCH_INTERVAL_MS = 3_600_000;
/** How long the OAuth state cookie is accepted for, in seconds. */
export const OAUTH_STATE_TTL_SECONDS = 600;

export const SIGNIN_EMAIL_LIMIT = 5;
export const SIGNIN_EMAIL_WINDOW_SECONDS = 600;

/** Prefix on every minted personal API key, before the random token. */
export const API_KEY_PREFIX = "orsko_sk_";
/** A user may hold at most this many non-revoked keys at once. */
export const MAX_ACTIVE_API_KEYS = 10;
export const KEY_MINT_LIMIT_PER_HOUR = 10;
export const KEY_MINT_WINDOW_SECONDS = 3600;
/** A key's `last_used_at` is written at most this often, to avoid a D1 write on every request. */
export const KEY_TOUCH_INTERVAL_MS = 3_600_000;

/**
 * A busy room's `last_activity_at` is mirrored into the D1 index at most
 * this often, so a burst of posts does not turn into a D1 write per message.
 * A room that goes quiet in between is still caught by `reconcile`.
 */
export const INDEX_ACTIVITY_THROTTLE_MS = 60_000;

/**
 * The longest request path a 404 repeats back. The path is useful to an agent
 * that guessed an endpoint, but a pathological URL is not worth reflecting.
 */
export const MAX_ECHOED_PATH_CHARS = 200;

/**
 * A member with no open stream socket that has made no authenticated call for
 * this long reads as `away`. Derived at read time: nobody is removed for it.
 */
export const AGENT_AWAY_AFTER_MS = 10 * 60_000;

/**
 * An observer with no open socket, unseen for this long, is marked left. A
 * browser tab closed without its pagehide leave would otherwise hold one of
 * the room's MAX_OBSERVERS_PER_ROOM slots forever.
 */
export const OBSERVER_EXPIRE_AFTER_MS = 5 * 60_000;

/** Longest outcome an agent may record, in characters (UTF-16 code units, as Zod counts). */
export const MAX_OUTCOME_CHARS = 2000;

/** Milliseconds in a minute, for turning a duration constant into minutes for copy. */
export const MS_PER_MINUTE = 60_000;

/**
 * How long a room's only agent waits alone before the room says nobody else
 * has joined. Sent at most once per room, from the shared room alarm.
 */
export const EMPTY_ROOM_NUDGE_MS = 10 * MS_PER_MINUTE;

/**
 * How late the nudge may fire and still be worth sending. A room whose alarm
 * did not run near EMPTY_ROOM_NUDGE_MS after the lone agent joined — because
 * it predates this feature, or its alarm was delayed for some other reason —
 * still gets `empty_nudge_at` stamped so it is never nudged, but past this
 * much slack the message itself would be stale and possibly days late, so it
 * is skipped rather than sent.
 */
export const EMPTY_ROOM_NUDGE_GRACE_MS = 5 * MS_PER_MINUTE;

/** Bytes in a mebibyte, for the size limits below. */
export const BYTES_PER_MIB = 1024 * 1024;
/**
 * The largest text `orsko_share_text` stores, in UTF-8 bytes. Half a mebibyte,
 * not a full one (controller ruling 2026-09-12): the spec's equal 1 MiB caps
 * made a full share impossible once wrapped in a JSON-RPC envelope under
 * MCP_MAX_BODY_BYTES.
 */
export const MCP_MAX_SHARED_TEXT_BYTES = BYTES_PER_MIB / 2;
/** The largest attachment `orsko_open_attachment` returns as text, in bytes. */
export const MCP_MAX_OPENED_TEXT_BYTES = BYTES_PER_MIB;
/** Attachment content types `orsko_open_attachment` decodes as UTF-8 text. */
export const MCP_TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
/**
 * The content type `orsko_share_text` stores, by lower-cased filename
 * extension. A Map, so no inherited key matches.
 */
export const SHARED_TEXT_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["csv", "text/csv"],
  ["json", "application/json"],
]);
/** What `orsko_share_text` stores for any other extension. */
export const SHARED_TEXT_DEFAULT_CONTENT_TYPE = "text/plain";

/**
 * The largest JSON-RPC request body `/mcp` reads, in bytes. A larger body
 * answers 413 before it reaches the MCP SDK. Comfortably larger than
 * MCP_MAX_SHARED_TEXT_BYTES so a maximum-size shared text still fits once
 * wrapped in a JSON-RPC envelope.
 */
export const MCP_MAX_BODY_BYTES = 2 * BYTES_PER_MIB;
/** The longest `orsko_read` may wait, in seconds. ChatGPT abandons a tool call after about sixty seconds. */
export const MCP_MAX_WAIT_SECONDS = 20;
/** How the connector names itself in the MCP `initialize` result. */
export const MCP_SERVER_NAME = "orsko";
export const MCP_SERVER_VERSION = "1.0.0";
/** JSON-RPC error codes the `/mcp` route answers with before the SDK runs. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_SERVER_ERROR = -32000;

/**
 * POST /api/pulse (cookieless page-view and click counting), per hashed IP.
 * Generous for real browsing, tight enough to stop a script flooding GA.
 */
export const EVENTS_LIMIT_PER_MINUTE = 120;
export const EVENTS_WINDOW_SECONDS = 60;
/** The largest legitimate event body (path, referrer, campaign tags) is well under this. */
export const EVENTS_MAX_BODY_BYTES = 4 * 1024;

/**
 * POST /api/feedback — notes left through the feedback page, per hashed IP.
 * A person writes one note, occasionally a few; anything beyond that is a
 * script, and the limiter window is an hour rather than a minute.
 */
export const FEEDBACK_LIMIT_PER_HOUR = 5;
export const FEEDBACK_WINDOW_SECONDS = 3600;
/** As much as anyone writes in the box; the page counts down to the same number. */
export const FEEDBACK_MESSAGE_MAX_CHARS = 2000;
/** The message at its longest in UTF-8, plus the address, the page and the JSON around them. */
export const FEEDBACK_MAX_BODY_BYTES = 16 * 1024;
