import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FEEDBACK_LIMIT_PER_HOUR } from "../../src/config/constants";
import { BASE, signInViaMagicLink } from "../helpers";

interface FeedbackRow {
  readonly id: string;
  readonly message: string;
  readonly contact: string | null;
  readonly page: string | null;
  readonly user_id: string | null;
  readonly created_at: number;
}

function post(body: unknown, init: { ip?: string; cookie?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": init.ip ?? "203.0.113.50",
  };
  if (init.cookie) headers.cookie = init.cookie;
  return SELF.fetch(`${BASE}/api/feedback`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rowFor(message: string): Promise<FeedbackRow | null> {
  return env.DB.prepare("SELECT * FROM feedback WHERE message = ?")
    .bind(message)
    .first<FeedbackRow>();
}

async function page(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  expect(res.status, path).toBe(200);
  return res.text();
}

describe("POST /api/feedback", () => {
  it("stores an anonymous note and answers 204", async () => {
    const message = "The relay seat saved me today.";
    const res = await post({ message }, { ip: "203.0.113.51" });
    expect(res.status).toBe(204);
    const row = await rowFor(message);
    expect(row?.contact).toBeNull();
    expect(row?.user_id).toBeNull();
    expect(row?.created_at).toBeGreaterThan(0);
  });

  it("keeps the reply address and the page, with room ids collapsed", async () => {
    const message = "Joining from Cursor was smooth.";
    const res = await post(
      { message, contact: " Visitor@Example.com ", page: "/r/abc123xyz?invite=secret" },
      { ip: "203.0.113.52" },
    );
    expect(res.status).toBe(204);
    const row = await rowFor(message);
    expect(row?.contact).toBe("Visitor@Example.com");
    // The room id and the invite never reach storage: /r/:room is all that is kept.
    expect(row?.page).toBe("/r/:room");
  });

  it("records the account when the visitor is signed in", async () => {
    const cookie = await signInViaMagicLink("feedback-user@example.com");
    const message = "Keys page could show the last use.";
    expect((await post({ message }, { ip: "203.0.113.53", cookie })).status).toBe(204);
    const row = await rowFor(message);
    expect(row?.user_id).toMatch(/\S/);
  });

  it("refuses a message that carries a credential", async () => {
    const message = "my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA please help";
    const res = await post({ message }, { ip: "203.0.113.54" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("secret_detected");
    expect(body.error.message).toContain("Anthropic API key");
    // Nothing containing the credential is stored.
    expect(await rowFor(message)).toBeNull();
  });

  it("rejects an empty, malformed or oversized body", async () => {
    expect((await post({ message: "" }, { ip: "203.0.113.55" })).status).toBe(400);
    expect((await post("not json", { ip: "203.0.113.55" })).status).toBe(400);
    expect((await post({ message: "x".repeat(9000) }, { ip: "203.0.113.55" })).status).toBe(400);
  });

  it("rate limits one address after a handful of notes", async () => {
    const ip = "203.0.113.56";
    for (let i = 0; i < FEEDBACK_LIMIT_PER_HOUR; i++)
      expect((await post({ message: `note number ${i}` }, { ip })).status).toBe(204);
    const res = await post({ message: "one too many" }, { ip });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; retryAfterSeconds?: number } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is same-origin only: no CORS headers are offered", async () => {
    const res = await SELF.fetch(`${BASE}/api/feedback`, {
      method: "OPTIONS",
      headers: { origin: "https://elsewhere.example", "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the feedback page", () => {
  it("is bundled as /feedback.html, which Workers Assets serves at /feedback", async () => {
    const html = await page("/feedback.html");
    expect(html).toContain("<title>Feedback — Orsko</title>");
    expect(html).toContain('<meta property="og:url" content="https://orsko.dev/feedback">');
    expect(html).toContain('<form id="feedback-form"');
    expect(html).toContain('<textarea id="feedback-message"');
    expect(html).toContain('id="feedback-contact"');
    expect(html).toContain('src="/feedback.js"');
  });

  it("says an address is optional and that credentials are refused", async () => {
    const html = (await page("/feedback.html")).replace(/\s+/g, " ");
    expect(html).toContain("Optional");
    expect(html).toContain("anonymous");
  });

  // A visitor who arrived on a pasted room link never sees the landing page,
  // so every page the product actually shows carries the link.
  it("is linked from every page", async () => {
    const pages = [
      "/index.html",
      "/room.html",
      "/private.html",
      "/connect.html",
      "/signin.html",
      "/me.html",
      "/me/keys.html",
      "/privacy.html",
      "/brand.html",
    ];
    for (const path of pages) expect(await page(path), path).toContain('href="/feedback"');
  });

  it("tells the visitor what a note stores", async () => {
    const html = (await page("/privacy.html")).replace(/\s+/g, " ");
    expect(html).toContain("Feedback");
    expect(html).toContain("what you type");
  });
});
