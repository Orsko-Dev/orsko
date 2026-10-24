import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUEST_PASTE_HINT, OWNER_PASTE_HINT } from "../../src/http/routes/room-page";
import { pasteSentenceFor, renderAgentInstructions } from "../../src/templates/agents";
import { BASE, createRoomViaHttp, signInViaMagicLink } from "../helpers";
import { attributeOf, elementText } from "../html";

afterEach(() => vi.restoreAllMocks());

async function page(path: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { accept: "text/html", ...headers } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  return res.text();
}

async function privateRoomWithMember(email: string) {
  const owner = await signInViaMagicLink(email);
  const created = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie: owner,
      "content-type": "application/json",
      "cf-connecting-ip": `10.9.3.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ private: true }),
  });
  const { roomId } = (await created.json()) as { roomId: string };
  const minted = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { cookie: owner, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: "{}",
  });
  const { token: invite } = (await minted.json()) as { token: string };
  const joined = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "member", invite }),
  });
  const { token } = (await joined.json()) as { token: string };
  return { owner, roomId, invite, token };
}

describe("the room page before any script runs", () => {
  it("carries the sentence, the markdown link and the instructions for a public room", async () => {
    const { roomId } = await createRoomViaHttp();
    const html = await page(`/r/${roomId}`);
    const sentence = pasteSentenceFor(env.PUBLIC_BASE_URL, roomId);
    expect(elementText(html, "paste")).toBe(sentence);
    expect(elementText(html, "paste-sentence")).toBe(sentence);
    expect(attributeOf(html, "md-link", "href")).toBe(`/r/${roomId}?format=md`);
    expect(elementText(html, "agent-instructions")).toBe(
      renderAgentInstructions(env.PUBLIC_BASE_URL, roomId),
    );
    // Escaped text, and ahead of every script the page loads.
    expect(html).not.toContain("<your-name>");
    expect(html).toContain("&lt;your-name&gt;");
    expect(html.indexOf('id="agent-instructions"')).toBeLessThan(
      html.indexOf('<script type="module" src="/avatar.js">'),
    );
  });

  it("shows the owner hint, not an invite-less sentence, on a private room", async () => {
    const { owner, roomId } = await privateRoomWithMember("page-owner@example.com");
    const html = await page(`/r/${roomId}`, { cookie: owner });
    expect(elementText(html, "paste")).toBe(OWNER_PASTE_HINT);
    expect(elementText(html, "paste-sentence")).toBe(pasteSentenceFor(env.PUBLIC_BASE_URL, roomId));
    expect(elementText(html, "agent-instructions")).toContain(`# Orsko room ${roomId}`);
  });

  it("shows members the guest hint and keeps the invite on the markdown link", async () => {
    const { roomId, invite, token } = await privateRoomWithMember("page-member@example.com");
    const html = await page(`/r/${roomId}?invite=${invite}`, { authorization: `Bearer ${token}` });
    expect(elementText(html, "paste")).toBe(GUEST_PASTE_HINT);
    expect(attributeOf(html, "md-link", "href")).toBe(
      `/r/${roomId}?format=md&invite=${encodeURIComponent(invite)}`,
    );
  });

  it("still serves the plain page for a room that does not exist", async () => {
    const html = await page("/r/abcdefghjkmn");
    expect(elementText(html, "agent-instructions")).toBe("");
    expect(attributeOf(html, "md-link", "href")).toBe("#");
  });

  it("keeps the instructions inside the How an agent joins details", async () => {
    const room = await (await env.ASSETS.fetch(new URL("/room.html", BASE))).text();
    const summary = room.indexOf("<summary>How an agent joins</summary>");
    const pre = room.indexOf('<pre id="agent-instructions" class="agent-instructions"></pre>');
    expect(summary).toBeGreaterThan(-1);
    expect(pre).toBeGreaterThan(summary);
    expect(pre).toBeLessThan(room.indexOf("</details>", summary));
    expect(room).toContain('<span id="paste-sentence" class="hidden"></span>');
  });
});
