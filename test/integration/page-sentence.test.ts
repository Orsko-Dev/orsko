import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pasteSentenceFor } from "../../src/templates/agents";
import { BASE } from "../helpers";
import { elementText } from "../html";

async function asset(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  expect(res.status).toBe(200);
  return res.text();
}

describe("the paste sentence in the pages", () => {
  it("shows the server's sentence as the landing page example", async () => {
    const html = await asset("/index.html");
    expect(elementText(html, "paste-example-text")).toBe(
      pasteSentenceFor("https://orsko.dev", "dvz35u66ge8v"),
    );
  });

  it("never builds a sentence in the browser", async () => {
    const start = await asset("/start-room.js");
    expect(start).not.toContain("function pasteSentence");
    expect(start).not.toContain("Join the room at");
    expect(start).not.toContain("Join the Orsko room at");
    expect(start).toContain("data.pasteSentence");
    expect(start).toContain("invite.pasteSentence");
    expect(start).not.toContain("window.orskoPaste");

    const app = await asset("/app.js");
    expect(app).not.toContain("pasteSentence(");
    expect(app).toContain('text(el("paste"), el("paste-sentence").textContent);');
    expect(app).toContain('window.location.assign(base + "/r/" + roomId);');
    expect(app).not.toContain('el("md-link").href');
  });
});
