import type { Context } from "hono";
import { Hono } from "hono";
import * as adb from "../../account/db";
import { isValidSenderShape, sendMagicLink } from "../../account/email";
import { exchangeCode, fetchGithubUser, githubAuthorizeUrl } from "../../account/github";
import { resolveIdentity, sameOriginRequest } from "../../account/identity";
import { linkPendingMembers } from "../../account/invite-index";
import {
  clearSessionCookie,
  clearStateCookie,
  createSession,
  destroySession,
  parseCookies,
  sessionCookie,
  signState,
  stateCookie,
  verifyState,
} from "../../account/session";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SIGNIN_EMAIL_LIMIT,
  SIGNIN_EMAIL_WINDOW_SECONDS,
} from "../../config/constants";
import type { Env } from "../../env";
import { generateToken, hashToken } from "../../util/ids";
import { logEvent } from "../../util/log";
import { nowMs } from "../../util/time";
import type { ErrorCode } from "../../validation/errors";
import { AppError } from "../../validation/errors";
import { SigninEmailBody } from "../../validation/schemas";
import { clientIp } from "../auth";
import { readJsonBody } from "../body";
import { wantsHtml } from "../negotiate";
import { respondError } from "../respond";

export const authRoutes = new Hono<{ Bindings: Env }>();

const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/**
 * GitHub sign-in needs its own three secrets. When any is missing the
 * GitHub routes answer 503 (or redirect a browser to /signin) independent
 * of whether email sign-in is configured, so a half-configured deployment
 * never takes both providers down together.
 */
export function githubReady(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.COOKIE_SECRET);
}

/**
 * Magic-link sign-in needs its own two secrets, checked independently of
 * GitHub's — a missing GitHub secret must never refuse email sign-in. It
 * also needs a well-formed `MAGIC_LINK_FROM` sender: a missing or malformed
 * value would otherwise reach Resend and get the message rejected there, so
 * we refuse up front and log once so the operator can fix configuration.
 */
export function emailReady(env: Env): boolean {
  if (!env.RESEND_API_KEY || !env.COOKIE_SECRET) return false;
  if (!env.MAGIC_LINK_FROM || !isValidSenderShape(env.MAGIC_LINK_FROM)) {
    logEvent("auth.email_sender_invalid", {});
    return false;
  }
  return true;
}

function githubRedirectUri(env: Env): string {
  return `${env.PUBLIC_BASE_URL}/auth/github/callback`;
}

function cookiesOf(c: { req: { header: (name: string) => string | undefined } }) {
  return parseCookies(c.req.header("cookie") ?? null);
}

/**
 * A browser that navigated here directly (clicking "Continue with GitHub",
 * or GitHub redirecting back to our callback) cannot do anything useful with
 * a raw JSON error body. When the request prefers HTML, send it back to the
 * sign-in page instead, carrying only the error code — never a message or a
 * token — as a query parameter for signin.js to render.
 */
function authError(c: Context, code: ErrorCode, message: string): Response {
  if (wantsHtml(c)) return c.redirect(`/signin?error=${encodeURIComponent(code)}`, 302);
  return respondError(c, code, message);
}

authRoutes.get("/github", async (c) => {
  if (!githubReady(c.env)) return authError(c, "auth_unavailable", "sign-in is not configured");
  const nonce = generateToken();
  const signed = await signState(c.env.COOKIE_SECRET ?? "", nonce);
  c.header("Set-Cookie", stateCookie(signed));
  return c.redirect(
    githubAuthorizeUrl(c.env.GITHUB_CLIENT_ID ?? "", nonce, githubRedirectUri(c.env)),
    302,
  );
});

authRoutes.get("/github/callback", async (c) => {
  if (!githubReady(c.env)) return authError(c, "auth_unavailable", "sign-in is not configured");
  const cookies = cookiesOf(c);
  const nonce = await verifyState(c.env.COOKIE_SECRET ?? "", cookies[OAUTH_STATE_COOKIE] ?? "");
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  if (!nonce || nonce !== state || !code) {
    c.header("Set-Cookie", clearStateCookie());
    return authError(c, "invalid_request", "invalid oauth state");
  }
  try {
    const token = await exchangeCode(c.env, code, githubRedirectUri(c.env));
    const gh = await fetchGithubUser(token);
    if (!gh.email) {
      c.header("Set-Cookie", clearStateCookie());
      return authError(c, "invalid_request", "your GitHub account has no verified email");
    }
    const user = await adb.upsertUserByEmail(c.env.DB, {
      email: gh.email,
      githubId: gh.id,
      githubLogin: gh.login,
      displayName: gh.name ?? gh.login,
      avatarUrl: gh.avatarUrl,
    });
    await linkPendingMembers(c.env.DB, user);
    const raw = await createSession(c.env.DB, user.id, c.req.header("user-agent") ?? "", nowMs());
    logEvent("auth.signin", { userId: user.id, method: "github" });
    c.header("Set-Cookie", sessionCookie(raw, SESSION_MAX_AGE_SECONDS), { append: true });
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.redirect("/me", 302);
  } catch (e) {
    c.header("Set-Cookie", clearStateCookie());
    if (e instanceof AppError) return authError(c, e.code, e.message);
    throw e;
  }
});

authRoutes.post("/email", async (c) => {
  if (!emailReady(c.env)) return respondError(c, "auth_unavailable", "sign-in is not configured");
  // Another site must not be able to make a browser ask us to mail a sign-in
  // link to an address it chose, the same rule the signout route applies.
  if (!sameOriginRequest(c)) return respondError(c, "forbidden", "cross-site request");
  const limiter = c.env.IP_LIMITER.getByName(`signin:${await hashToken(clientIp(c))}`);
  const gate = await limiter.hit({
    limit: SIGNIN_EMAIL_LIMIT,
    windowSeconds: SIGNIN_EMAIL_WINDOW_SECONDS,
  });
  if (!gate.allowed)
    return respondError(c, "rate_limited", "too many sign-in emails", gate.retryAfterSeconds);
  const body = await readJsonBody(c);
  if (!body.ok) return respondError(c, body.code, body.message);
  const parsed = SigninEmailBody.safeParse(body.value);
  if (!parsed.success) return respondError(c, "invalid_request", "a valid email is required");
  const email = parsed.data.email.toLowerCase();
  const raw = generateToken();
  await adb.insertMagicLink(c.env.DB, {
    tokenHash: await hashToken(raw),
    email,
    now: nowMs(),
  });
  const link = `${c.env.PUBLIC_BASE_URL}/auth/email/callback?token=${encodeURIComponent(raw)}`;
  try {
    await sendMagicLink(c.env, email, link);
  } catch (e) {
    // The response is the same either way: whether an address exists or the
    // provider failed is not the caller's business.
    logEvent("auth.email_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
  }
  return c.body(null, 202);
});

authRoutes.get("/email/callback", async (c) => {
  const raw = c.req.query("token") ?? "";
  const email = raw ? await adb.consumeMagicLink(c.env.DB, await hashToken(raw), nowMs()) : null;
  if (!email)
    return respondError(c, "invalid_request", "this sign-in link is invalid or has expired");
  const user = await adb.upsertUserByEmail(c.env.DB, { email });
  // Any room an invite addressed to this person already admitted an agent to
  // becomes theirs the moment they have an account to own it.
  await linkPendingMembers(c.env.DB, user);
  const session = await createSession(c.env.DB, user.id, c.req.header("user-agent") ?? "", nowMs());
  logEvent("auth.signin", { userId: user.id, method: "email" });
  c.header("Set-Cookie", sessionCookie(session, SESSION_MAX_AGE_SECONDS));
  return c.redirect("/me", 302);
});

authRoutes.post("/signout", async (c) => {
  if (!sameOriginRequest(c)) return respondError(c, "forbidden", "cross-site request");
  await destroySession(c.env.DB, cookiesOf(c)[SESSION_COOKIE] ?? "");
  c.header("Set-Cookie", clearSessionCookie());
  return c.body(null, 204);
});

export const meRoot = new Hono<{ Bindings: Env }>();

meRoot.get("/", async (c) => {
  const identity = await resolveIdentity(c);
  if (!identity) return respondError(c, "unauthorized", "sign in required");
  const u = await adb.findUserById(c.env.DB, identity.userId);
  if (!u) return respondError(c, "unauthorized", "sign in required");
  return c.json({
    user: {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
      githubLogin: u.github_login,
      plan: u.plan,
    },
  });
});
