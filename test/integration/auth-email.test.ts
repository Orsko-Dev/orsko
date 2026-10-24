import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { authRoutes, emailReady } from "../../src/http/routes/auth";
import { BASE } from "../helpers";

afterEach(() => vi.restoreAllMocks());

describe("magic link sign-in", () => {
  it("sends a link and signs in once", async () => {
    let link = "";
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body)) as { text: string };
        link = /https?:\/\/\S+/.exec(String(body.text))?.[0] ?? "";
        return Response.json({ id: "email_1" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    const req = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ email: "Bob@Example.com" }),
    });
    expect(req.status).toBe(202);
    expect(link).toContain("/auth/email/callback?token=");
    const parsed = new URL(link);
    const path = parsed.pathname + parsed.search;
    const cb = await SELF.fetch(`${BASE}${path}`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    const session = cb.headers.get("set-cookie")?.split(";")[0] ?? "";
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: session } });
    expect(await me.json()).toMatchObject({ user: { email: "bob@example.com" } });

    const out = await SELF.fetch(`${BASE}/auth/signout`, {
      method: "POST",
      headers: { cookie: session, "sec-fetch-site": "same-origin" },
    });
    expect(out.status).toBe(204);
    const after = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: session } });
    expect(after.status).toBe(401);

    const again = await SELF.fetch(`${BASE}${path}`, { redirect: "manual" });
    expect(again.status).toBe(400);
  });

  it("sends a branded html body and a plain-text alternative from the configured sender", async () => {
    let payload: { from: string; subject: string; html: string; text: string } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.resend.com/emails") {
        payload = JSON.parse(String(init?.body)) as typeof payload;
        return Response.json({ id: "email_from" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    const res = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.12" },
      body: JSON.stringify({ email: "dana@example.com" }),
    });
    expect(res.status).toBe(202);
    const body = payload as unknown as {
      from: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe(env.MAGIC_LINK_FROM);
    expect(body.subject).toBe("Your Orsko sign-in link");
    expect(body.html).toContain(`${env.PUBLIC_BASE_URL}/brand/orsko-mark-email.png`);
    expect(body.html).toContain("Sign in to Orsko");
    expect(body.text).toContain("expires in 15 minutes");
    const link = /https?:\/\/\S+auth\/email\/callback\S+/.exec(body.text)?.[0] ?? "";
    expect(link).not.toBe("");
    expect(body.html).toContain(link.replace(/&/g, "&amp;"));
  });

  it("rejects an invalid email address", async () => {
    const res = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an email address padded with whitespace", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ id: "email_2" })) as typeof fetch);
    const res = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.99" },
      body: JSON.stringify({ email: " bob@example.com " }),
    });
    expect(res.status).toBe(202);
  });

  it("rate limits sign-in emails per ip and never reveals whether the email exists", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ id: "x" })) as typeof fetch);
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await SELF.fetch(`${BASE}/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
        body: JSON.stringify({ email: `x${i}@example.com` }),
      });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it("still answers 202 when the email provider fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("nope", { status: 500 })) as typeof fetch,
    );
    const res = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
      body: JSON.stringify({ email: "carol@example.com" }),
    });
    expect(res.status).toBe(202);
  });

  it("still answers 202 when only GitHub is unconfigured", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ id: "email_no_github" })) as typeof fetch);
    const emailOnlyEnv: Env = {
      ...env,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
    };
    const res = await authRoutes.fetch(
      new Request("http://example.com/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.201",
        },
        body: JSON.stringify({ email: "erin@example.com" }),
      }),
      emailOnlyEnv,
    );
    expect(res.status).toBe(202);
  });

  it("refuses a cross-site sign-in email", async () => {
    const res = await SELF.fetch(`${BASE}/auth/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        "cf-connecting-ip": "203.0.113.44",
      },
      body: JSON.stringify({ email: "victim@example.com" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("refuses a cross-site signout", async () => {
    const res = await SELF.fetch(`${BASE}/auth/signout`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("signs out and clears the cookie", async () => {
    const res = await SELF.fetch(`${BASE}/auth/signout`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("emailReady is false without a configured MAGIC_LINK_FROM", () => {
    expect(
      emailReady({
        RESEND_API_KEY: "re_test",
        COOKIE_SECRET: "cookie-secret-for-tests",
      } as never),
    ).toBe(false);
    expect(
      emailReady({
        RESEND_API_KEY: "re_test",
        COOKIE_SECRET: "cookie-secret-for-tests",
        MAGIC_LINK_FROM: "",
      } as never),
    ).toBe(false);
  });

  it("answers 503 when MAGIC_LINK_FROM is missing", async () => {
    const noSenderEnv: Env = { ...env, MAGIC_LINK_FROM: "" };
    const res = await authRoutes.fetch(
      new Request("http://example.com/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.202",
        },
        body: JSON.stringify({ email: "frank@example.com" }),
      }),
      noSenderEnv,
    );
    expect(res.status).toBe(503);
  });
});
