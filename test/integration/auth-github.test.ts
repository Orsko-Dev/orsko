import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { authRoutes, emailReady, githubReady } from "../../src/http/routes/auth";
import { BASE } from "../helpers";

function mockGithub(user: { id: number; login: string; email: string | null }) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token"))
      return Response.json({ access_token: "gh_tok" });
    if (url === "https://api.github.com/user")
      return Response.json({
        id: user.id,
        login: user.login,
        name: "Alice",
        avatar_url: "https://avatars.example/1",
      });
    if (url === "https://api.github.com/user/emails")
      return Response.json([{ email: user.email ?? "", primary: true, verified: true }]);
    throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch);
}

async function startGithubFlow(): Promise<{ stateCookie: string; state: string }> {
  const start = await SELF.fetch(`${BASE}/auth/github`, { redirect: "manual" });
  const stateCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  return { stateCookie, state };
}

afterEach(() => vi.restoreAllMocks());

describe("github sign-in", () => {
  it("redirects to github with a signed state cookie", async () => {
    const res = await SELF.fetch(`${BASE}/auth/github`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(res.headers.get("set-cookie")).toContain("orsko_oauth_state=");
  });

  it("completes the callback, creates a session, and /api/me works", async () => {
    const { stateCookie, state } = await startGithubFlow();
    mockGithub({ id: 42, login: "alice", email: "alice@example.com" });
    const cb = await SELF.fetch(
      `${BASE}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/me");

    // The session cookie must be set and the one-time oauth state cookie cleared.
    const setCookies = cb.headers.getSetCookie();
    expect(setCookies.some((v) => v.startsWith("orsko_session="))).toBe(true);
    expect(
      setCookies.some((v) => v.startsWith("orsko_oauth_state=") && v.includes("Max-Age=0")),
    ).toBe(true);

    const session = setCookies.find((v) => v.startsWith("orsko_session="))?.split(";")[0] ?? "";
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: "alice@example.com", githubLogin: "alice" },
    });
  });

  it("rejects a callback when the github account has no verified email", async () => {
    const { stateCookie, state } = await startGithubFlow();
    mockGithub({ id: 42, login: "alice", email: null });
    const cb = await SELF.fetch(
      `${BASE}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(cb.status).toBe(400);
    expect(await cb.json()).toMatchObject({ error: { code: "invalid_request" } });
    // The one-time oauth state cookie is cleared on this failure path too.
    expect(cb.headers.get("set-cookie")).toContain("orsko_oauth_state=;");
  });

  it("returns 503 when github times out, while the email sign-in path stays unaffected", async () => {
    const { stateCookie, state } = await startGithubFlow();
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch);
    const cb = await SELF.fetch(
      `${BASE}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(cb.status).toBe(503);
    expect(await cb.json()).toMatchObject({ error: { code: "auth_unavailable" } });

    const req = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.201" },
      body: JSON.stringify({ email: "dana@example.com" }),
    });
    expect(req.status).toBe(202);
  });

  it("rejects a callback with a bad state", async () => {
    mockGithub({ id: 42, login: "alice", email: "alice@example.com" });
    const cb = await SELF.fetch(`${BASE}/auth/github/callback?code=abc&state=nope`, {
      redirect: "manual",
    });
    expect(cb.status).toBe(400);
  });

  it("rejects /api/me without a session", async () => {
    const res = await SELF.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("githubReady is true only with its own three secrets, regardless of Resend", () => {
    expect(
      githubReady({
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
        COOKIE_SECRET: "c",
      } as never),
    ).toBe(true);
    expect(
      githubReady({
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
        COOKIE_SECRET: "c",
        RESEND_API_KEY: "d",
      } as never),
    ).toBe(true);
    expect(
      githubReady({ GITHUB_CLIENT_SECRET: "b", COOKIE_SECRET: "c", RESEND_API_KEY: "d" } as never),
    ).toBe(false);
    expect(
      githubReady({ GITHUB_CLIENT_ID: "a", COOKIE_SECRET: "c", RESEND_API_KEY: "d" } as never),
    ).toBe(false);
    expect(
      githubReady({
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
        RESEND_API_KEY: "d",
      } as never),
    ).toBe(false);
  });

  it("emailReady is true only with its own secrets and a well-formed sender, regardless of GitHub", () => {
    const MAGIC_LINK_FROM = "Orsko <signin@notifications.orsko.dev>";
    expect(emailReady({ RESEND_API_KEY: "d", COOKIE_SECRET: "c", MAGIC_LINK_FROM } as never)).toBe(
      true,
    );
    expect(
      emailReady({
        RESEND_API_KEY: "d",
        COOKIE_SECRET: "c",
        MAGIC_LINK_FROM,
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
      } as never),
    ).toBe(true);
    expect(
      emailReady({
        COOKIE_SECRET: "c",
        MAGIC_LINK_FROM,
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
      } as never),
    ).toBe(false);
    expect(
      emailReady({
        RESEND_API_KEY: "d",
        MAGIC_LINK_FROM,
        GITHUB_CLIENT_ID: "a",
        GITHUB_CLIENT_SECRET: "b",
      } as never),
    ).toBe(false);
    expect(
      emailReady({ RESEND_API_KEY: "d", COOKIE_SECRET: "c", MAGIC_LINK_FROM: "" } as never),
    ).toBe(false);
    expect(
      emailReady({
        RESEND_API_KEY: "d",
        COOKIE_SECRET: "c",
        MAGIC_LINK_FROM: "not a valid sender",
      } as never),
    ).toBe(false);
  });

  it("GET /auth/github still redirects to github.com when only Resend is missing", async () => {
    const githubOnlyEnv: Env = { ...env, RESEND_API_KEY: undefined };
    const res = await authRoutes.fetch(new Request("http://example.com/github"), githubOnlyEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
  });

  it("sends a browser to /signin instead of raw JSON when secrets are missing", async () => {
    const noSecretsEnv = {} as Env;

    const htmlRes = await authRoutes.fetch(
      new Request("http://example.com/github", { headers: { accept: "text/html" } }),
      noSecretsEnv,
    );
    expect(htmlRes.status).toBe(302);
    expect(htmlRes.headers.get("location")).toBe("/signin?error=auth_unavailable");

    const jsonRes = await authRoutes.fetch(
      new Request("http://example.com/github", { headers: { accept: "application/json" } }),
      noSecretsEnv,
    );
    expect(jsonRes.status).toBe(503);
    expect(await jsonRes.json()).toMatchObject({ error: { code: "auth_unavailable" } });
  });

  it("sends a browser to /signin with the error code on a bad-state callback", async () => {
    const res = await SELF.fetch(`${BASE}/auth/github/callback?code=abc&state=nope`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin?error=invalid_request");
  });
});
