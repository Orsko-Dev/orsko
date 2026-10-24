import type { IpLimiterObject } from "./limiter/IpLimiterObject";
import type { RoomObject } from "./room/RoomObject";

export interface Env {
  ROOM: DurableObjectNamespace<RoomObject>;
  IP_LIMITER: DurableObjectNamespace<IpLimiterObject>;
  ARCHIVE: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL: string;
  /** The Resend sender for magic-link email, e.g. "Orsko <signin@notifications.orsko.dev>". */
  MAGIC_LINK_FROM: string;
  /** Test-only override for the stream handshake deadline, in milliseconds. */
  STREAM_HELLO_TIMEOUT_MS?: string;
  /** Test-only override for how many invites an account may mint per hour. */
  INVITE_MINT_LIMIT_PER_HOUR?: string;
  DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  COOKIE_SECRET?: string;
  /** The GA4 property's measurement id, e.g. "G-XXXXXXXXXX" (a wrangler secret, so a fork never reports into ours). */
  GA4_MEASUREMENT_ID?: string;
  /** The GA4 Measurement Protocol API secret (a wrangler secret). Room analytics are off without it. */
  GA4_API_SECRET?: string;
  /** Where feedback notifications are sent. Without it, notes are stored and no mail goes out. */
  FEEDBACK_TO?: string;
  /** PostHog project token. Public by design, but kept as a wrangler secret so a fork never reports into ours. */
  POSTHOG_PROJECT_TOKEN?: string;
  /** PostHog ingestion host, e.g. "https://us.i.posthog.com". Server events and the /lens proxy use it. */
  POSTHOG_HOST?: string;
}
