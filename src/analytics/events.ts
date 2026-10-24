import { z } from "zod";
import { hmacSha256Hex } from "../util/hmac";
import type { AnalyticsEvent } from "./ga4";

/**
 * First-party, cookieless measurement for the public pages: page views, clicks
 * on a fixed set of buttons and links, and launch-video plays. The browser
 * stores nothing; the server scrubs every value again before forwarding it to
 * GA4, and identifies a visitor only by a keyed hash that rotates every UTC day.
 */

export const PUBLIC_EVENT_NAMES = ["page_view", "click", "video_play"] as const;

export const CLICK_TARGETS = [
  "start_room",
  "have_link",
  "copy_sentence",
  "connector_link",
  "copy_connector",
] as const;

const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
] as const;

const MAX_PATH_CHARS = 512;
const MAX_REFERRER_CHARS = 2048;
const MAX_CAMPAIGN_VALUE_CHARS = 100;
const ROOM_PATH = /^\/r\/[^/]+/;

const campaignValue = z.string().min(1).max(MAX_CAMPAIGN_VALUE_CHARS).optional();

const CampaignTags = z
  .object({
    utm_source: campaignValue,
    utm_medium: campaignValue,
    utm_campaign: campaignValue,
    utm_term: campaignValue,
    utm_content: campaignValue,
    utm_id: campaignValue,
  })
  .strict();

export const PublicEventBody = z
  .object({
    name: z.enum(PUBLIC_EVENT_NAMES),
    path: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARS)
      .regex(/^\/(?!\/)/, "path must be a site path starting with /"),
    referrer: z.string().max(MAX_REFERRER_CHARS).optional(),
    target: z.enum(CLICK_TARGETS).optional(),
    utm: CampaignTags.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.name === "click" && body.target === undefined)
      ctx.addIssue({ code: "custom", path: ["target"], message: "a click needs a target" });
    if (body.name !== "click" && body.target !== undefined)
      ctx.addIssue({ code: "custom", path: ["target"], message: "only a click has a target" });
  });

export type PublicEvent = z.infer<typeof PublicEventBody>;

/** A site path with any query and fragment removed and room ids collapsed. */
export function scrubPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const collapsed = bare.replace(ROOM_PATH, "/r/:room");
  return collapsed.startsWith("/") ? collapsed : "/";
}

/** An external referrer reduced to its origin; a same-origin one keeps its scrubbed path. */
export function scrubReferrer(referrer: string | undefined, siteOrigin: string): string {
  if (!referrer) return "";
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.origin !== siteOrigin) return url.origin;
  return `${url.origin}${scrubPath(url.pathname)}`;
}

/** The UTC calendar day, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A GA client id for one visitor on one day (32 hex characters). It is never
 * stored, rotates at midnight UTC, and cannot be turned back into the inputs.
 */
export async function visitorClientId(
  secret: string,
  day: string,
  ip: string,
  userAgent: string,
): Promise<string> {
  const digest = await hmacSha256Hex(secret, `visitor:${day}:${ip}:${userAgent}`);
  return digest.slice(0, 32);
}

function campaignQuery(utm: PublicEvent["utm"]): string {
  if (!utm) return "";
  const pairs: string[] = [];
  for (const key of CAMPAIGN_KEYS) {
    const value = utm[key];
    if (value) pairs.push(`${key}=${encodeURIComponent(value)}`);
  }
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

/** The GA4 event for one validated public event, with every URL scrubbed. */
export function toGa4Event(body: PublicEvent, siteOrigin: string): AnalyticsEvent {
  const pageLocation = `${siteOrigin}${scrubPath(body.path)}${campaignQuery(body.utm)}`;
  if (body.name === "page_view") {
    return {
      name: "page_view",
      params: {
        page_location: pageLocation,
        page_referrer: scrubReferrer(body.referrer, siteOrigin),
      },
    };
  }
  if (body.name === "click") {
    return {
      name: "cta_click",
      params: { target: body.target ?? "unknown", page_location: pageLocation },
    };
  }
  return { name: "video_start", params: { page_location: pageLocation } };
}
