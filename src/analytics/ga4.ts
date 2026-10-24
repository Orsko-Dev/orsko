import { hmacSha256Hex } from "../util/hmac";
import { logFailure } from "../util/log";

/**
 * Server-side Google Analytics 4 events for room activity, sent through the
 * Measurement Protocol. Rooms are measured here rather than with the browser
 * tag because the room link is the room's only credential and agents join
 * without ever running a page script. Nothing that identifies a room, a member
 * or a message leaves the Worker: the GA client id is a keyed hash of the room
 * id, so GA can count distinct rooms without learning any of them.
 */

export const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

/** Room events (server-side) and public-page events (src/analytics/events.ts). */
export type Ga4EventName =
  | "room_created"
  | "room_joined"
  | "room_viewed"
  | "room_instructions_read"
  | "page_view"
  | "cta_click"
  | "video_start";

export type EventParamValue = string | number | boolean;

export interface AnalyticsEvent {
  readonly name: Ga4EventName;
  readonly params: Readonly<Record<string, EventParamValue>>;
}

export interface Ga4Config {
  readonly measurementId: string | undefined;
  readonly apiSecret: string | undefined;
}

export interface Ga4Payload {
  readonly client_id: string;
  readonly non_personalized_ads: true;
  readonly events: ReadonlyArray<{
    readonly name: Ga4EventName;
    readonly params: Readonly<Record<string, EventParamValue>>;
  }>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A stable, non-reversible GA client id for one room (32 hex characters). */
export async function ga4ClientId(secret: string, roomId: string): Promise<string> {
  const digest = await hmacSha256Hex(secret, `orsko-room:${roomId}`);
  return digest.slice(0, 32);
}

/**
 * One Measurement Protocol body. GA only counts an event toward users and
 * sessions when it carries an engagement time, so a nominal 1 ms is added.
 */
export function buildGa4Payload(clientId: string, event: AnalyticsEvent): Ga4Payload {
  return {
    client_id: clientId,
    non_personalized_ads: true,
    events: [{ name: event.name, params: { ...event.params, engagement_time_msec: 1 } }],
  };
}

/**
 * Sends one room event, identified by the keyed hash of its room id. A missing
 * configuration is a silent no-op.
 */
export async function sendGa4Event(
  config: Ga4Config,
  roomId: string,
  event: AnalyticsEvent,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!config.measurementId || !config.apiSecret) return;
  const clientId = await ga4ClientId(config.apiSecret, roomId);
  await postGa4Event(config, clientId, event, fetchImpl);
}

/**
 * Posts one event for an already-derived client id. A missing configuration is
 * a silent no-op, and every failure is logged and swallowed: analytics must
 * never fail a request.
 */
export async function postGa4Event(
  config: Ga4Config,
  clientId: string,
  event: AnalyticsEvent,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { measurementId, apiSecret } = config;
  if (!measurementId || !apiSecret) return;
  try {
    const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildGa4Payload(clientId, event)),
    });
    if (!res.ok) logFailure("analytics.ga4_rejected", { event: event.name, status: res.status });
  } catch (error: unknown) {
    logFailure("analytics.ga4_failed", {
      event: event.name,
      errorClass: error instanceof Error ? error.name : "unknown",
    });
  }
}
