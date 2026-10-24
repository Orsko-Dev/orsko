import type { Context } from "hono";
import type { Env } from "../env";
import { type AnalyticsEvent, sendGa4Event } from "./ga4";
import { sendPosthogEvent } from "./posthog";

/** Records one room event in the background; the caller never waits on it. */
export type RoomTracker = (roomId: string, event: AnalyticsEvent) => void;

/** The tracker for callers with nowhere to report to (and tests that build servers directly). */
export const NO_TRACKING: RoomTracker = () => {};

/**
 * A tracker that hands each send to `waitUntil`, so the response goes out
 * immediately. Each destination — Google Analytics and PostHog — reports only
 * when it is configured; with neither configured the tracker does nothing at
 * all, not even scheduling work.
 */
export function roomTracker(env: Env, waitUntil: (work: Promise<unknown>) => void): RoomTracker {
  const ga4 = { measurementId: env.GA4_MEASUREMENT_ID, apiSecret: env.GA4_API_SECRET };
  const posthog = {
    host: env.POSTHOG_HOST,
    token: env.POSTHOG_PROJECT_TOKEN,
    secret: env.COOKIE_SECRET,
  };
  const toGa4 = Boolean(ga4.measurementId && ga4.apiSecret);
  const toPosthog = Boolean(posthog.host && posthog.token && posthog.secret);
  if (!toGa4 && !toPosthog) return NO_TRACKING;
  return (roomId, event) => {
    if (toGa4) waitUntil(sendGa4Event(ga4, roomId, event));
    if (toPosthog) waitUntil(sendPosthogEvent(posthog, roomId, event));
  };
}

/** The tracker for one Hono request. */
export function trackerFor(c: Context<{ Bindings: Env }>): RoomTracker {
  return roomTracker(c.env, (work) => c.executionCtx.waitUntil(work));
}
