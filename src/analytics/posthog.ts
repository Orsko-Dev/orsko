import { hmacSha256Hex } from "../util/hmac";
import { logFailure } from "../util/log";
import type { AnalyticsEvent, EventParamValue, FetchLike } from "./ga4";

/**
 * Server-side PostHog events for room activity. Agents join rooms through the
 * API and the connector without ever running a browser, so room activity can
 * only be measured here. The same rule as Google Analytics applies: nothing
 * that identifies a room, a member or a message leaves the Worker. The PostHog
 * distinct id is a keyed hash of the room id, so PostHog can tell rooms apart
 * without learning any of them, and no person profile is created.
 */

export const POSTHOG_CAPTURE_PATH = "/i/v0/e/";

export interface PosthogConfig {
  /** The ingestion host, e.g. "https://us.i.posthog.com". */
  readonly host: string | undefined;
  /** The project token. It is public by design: the browser SDK ships it to every visitor. */
  readonly token: string | undefined;
  /** The key for the room hash. Without it no id can be derived, so nothing is sent. */
  readonly secret: string | undefined;
}

export interface PosthogEvent {
  readonly api_key: string;
  readonly event: string;
  readonly distinct_id: string;
  readonly properties: Readonly<Record<string, EventParamValue>>;
}

/** A stable, non-reversible PostHog distinct id for one room. */
export async function posthogDistinctId(secret: string, roomId: string): Promise<string> {
  const digest = await hmacSha256Hex(secret, `orsko-posthog-room:${roomId}`);
  return `room_${digest.slice(0, 32)}`;
}

/** The static-assets host that serves PostHog's browser bundles for an ingestion host. */
export function posthogAssetsOrigin(host: string): string {
  return host.replace(".i.posthog.com", "-assets.i.posthog.com");
}

export function buildPosthogEvent(
  token: string,
  distinctId: string,
  event: AnalyticsEvent,
): PosthogEvent {
  return {
    api_key: token,
    event: event.name,
    distinct_id: distinctId,
    properties: { ...event.params, source: "server", $process_person_profile: false },
  };
}

/**
 * Sends one room event. A missing configuration is a silent no-op, and every
 * failure is logged and swallowed: analytics must never fail a request.
 */
export async function sendPosthogEvent(
  config: PosthogConfig,
  roomId: string,
  event: AnalyticsEvent,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { host, token, secret } = config;
  if (!host || !token || !secret) return;
  try {
    const distinctId = await posthogDistinctId(secret, roomId);
    const res = await fetchImpl(`${host}${POSTHOG_CAPTURE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPosthogEvent(token, distinctId, event)),
    });
    if (!res.ok)
      logFailure("analytics.posthog_rejected", { event: event.name, status: res.status });
  } catch (error: unknown) {
    logFailure("analytics.posthog_failed", {
      event: event.name,
      errorClass: error instanceof Error ? error.name : "unknown",
    });
  }
}
