import type { Context } from "hono";
import { SESSION_COOKIE } from "../config/constants";
import type { Env } from "../env";
import { nowMs } from "../util/time";
import { resolveApiKey } from "./keys";
import { parseCookies, resolveSession } from "./session";

export interface Identity {
  readonly userId: string;
  readonly via: "session" | "key";
}

/**
 * Resolves the caller's identity from an `X-Orsko-Key` header if present,
 * otherwise from the `orsko_session` cookie. A key takes priority so agents
 * that also happen to carry a browser session cookie authenticate as the
 * key's user.
 */
export async function resolveIdentity(c: Context<{ Bindings: Env }>): Promise<Identity | null> {
  const key = c.req.header("x-orsko-key");
  if (key) {
    const k = await resolveApiKey(c.env.DB, key, nowMs());
    return k ? { userId: k.userId, via: "key" } : null;
  }
  const cookies = parseCookies(c.req.header("cookie") ?? null);
  const s = await resolveSession(c.env.DB, cookies[SESSION_COOKIE] ?? "", nowMs());
  return s ? { userId: s.userId, via: "session" } : null;
}

/**
 * Whether a request came from our own pages. Browsers that send
 * `Sec-Fetch-Site` mark same-origin navigations and fetches; a missing header
 * means a client that does not send it at all (curl, older browsers), which is
 * accepted because the cookie is SameSite=Lax and cross-site form posts would
 * carry `cross-site` here.
 */
export function sameOriginRequest(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}
