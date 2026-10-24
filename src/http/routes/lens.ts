import { Hono } from "hono";
import { posthogAssetsOrigin } from "../../analytics/posthog";
import type { Env } from "../../env";
import { errorBody } from "../../validation/errors";
import { respondError } from "../respond";

/**
 * /lens/* — a first-party path for PostHog's browser SDK. Ad-block lists block
 * PostHog's own domains (i.posthog.com, *-assets.i.posthog.com), so the public
 * pages talk to orsko.dev and the Worker relays to PostHog. Static bundles go
 * to the assets host; everything else (events, recordings, flags) to the
 * ingestion host.
 *
 * Only an allowlist of headers is forwarded. In particular the Orsko session
 * cookie, a bearer token and an Orsko API key — all of which a browser may
 * attach to a same-origin request — never reach PostHog, and PostHog can never
 * set a cookie on orsko.dev.
 */
export const lensProxy = new Hono<{ Bindings: Env }>();

const PREFIX = "/lens";
const METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "content-encoding",
  "accept",
  "accept-language",
  "user-agent",
];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
];

/** The PostHog URL for one /lens request, or null when PostHog is not configured. */
export function upstreamUrl(requestUrl: string, host: string | undefined): string | null {
  if (!host) return null;
  const url = new URL(requestUrl);
  const rest = url.pathname.slice(PREFIX.length) || "/";
  const origin = rest.startsWith("/static/") ? posthogAssetsOrigin(host) : host;
  return `${origin}${rest}${url.search}`;
}

function pick(from: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

lensProxy.all("/*", async (c) => {
  const method = c.req.method.toUpperCase();
  if (!METHODS.has(method)) {
    c.header("Allow", [...METHODS].join(", "));
    return c.json(errorBody("invalid_request", "method not allowed here"), 405);
  }
  const target = upstreamUrl(c.req.url, c.env.POSTHOG_HOST);
  if (!target) return respondError(c, "not_found", "not found");

  const headers = pick(c.req.raw.headers, FORWARDED_REQUEST_HEADERS);
  // PostHog derives an approximate location from the visitor's address.
  const clientIp = c.req.header("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const hasBody = method !== "GET" && method !== "HEAD";
  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody ? await c.req.raw.arrayBuffer() : null,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: pick(upstream.headers, FORWARDED_RESPONSE_HEADERS),
  });
});
