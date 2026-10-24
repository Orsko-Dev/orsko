import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "../helpers";

describe("connector discovery", () => {
  it("serves the connector setup page at /connect", async () => {
    const res = await SELF.fetch(`${BASE}/connect`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="connector-url"');
    expect(html).toContain("https://orsko.dev/mcp");
    expect(html).toContain("claude mcp add --transport http orsko https://orsko.dev/mcp");
    expect(html).toContain("<h2>ChatGPT</h2>");
    expect(html).toContain("<h2>Claude.ai and Claude Desktop</h2>");
    expect(html).toContain("<h2>Claude Code</h2>");
    expect(html).toContain("<h2>Cursor and other MCP clients</h2>");
    expect(html).toContain("<h2>Everything else: the relay seat</h2>");
    expect(html).toContain("Developer mode");
    expect(html).toContain("Connectors");
    expect(html).toContain("ChatGPT Business, Enterprise and Edu");
    expect(html).toContain("ChatGPT Pro allows only read and fetch tools");
    expect(html).toContain("ChatGPT Free and Plus have no custom connectors");
    expect(html).toContain("Relay for an assistant");
    expect(html).toContain('src="/connect.js"');
    expect(html).not.toMatch(/(Plus|Pro)[^.<]*post[^.<]*through the connector/);
  });

  it("fills the connector URL from PUBLIC_BASE_URL instead of a hardcoded host", async () => {
    const res = await SELF.fetch(`${BASE}/connect`, { headers: { accept: "text/html" } });
    const html = await res.text();
    expect(html).toContain(`${env.PUBLIC_BASE_URL}/mcp`);
    expect(html).toContain(`claude mcp add --transport http orsko ${env.PUBLIC_BASE_URL}/mcp`);
    expect(html).toContain(`"url": "${env.PUBLIC_BASE_URL}/mcp"`);
    expect(html).toContain(`"args": ["-y", "mcp-remote", "${env.PUBLIC_BASE_URL}/mcp"]`);
  });

  it("sends Claude users to the routes that work, not the failing connector flow", async () => {
    const res = await SELF.fetch(`${BASE}/connect`, { headers: { accept: "text/html" } });
    const html = await res.text();
    const section = html
      .slice(
        html.indexOf("<h2>Claude.ai and Claude Desktop</h2>"),
        html.indexOf("<h2>Claude Code</h2>"),
      )
      // The prose wraps in the source, so compare it as one line.
      .replace(/\s+/g, " ");
    // claude.ai's connector flow demands an OAuth sign-in service even from a
    // server that advertises none, so the page sends Claude users elsewhere
    // (anthropics/claude-ai-mcp#457, closed as not planned).
    expect(section).toContain("does not work today");
    expect(section).toContain("Couldn't register with Orsko's sign-in service");
    expect(section).toContain("https://github.com/anthropics/claude-ai-mcp/issues/457");
    // Claude Desktop bridges to this server; the web and mobile apps relay.
    expect(section).toContain("<h3>Claude Desktop</h3>");
    expect(section).toContain("mcp-remote");
    expect(section).toContain("claude_desktop_config.json");
    expect(section).toContain("<h3>Claude on the web and mobile</h3>");
    expect(section).toContain("relay seat");
    expect(section).toContain(
      "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    );
  });

  it("gives /connect exactly one ultramarine accent element, the copy button", async () => {
    const res = await SELF.fetch(`${BASE}/connect`, { headers: { accept: "text/html" } });
    const html = await res.text();
    const accentMatches = html.match(/\bbtn-accent\b/g) ?? [];
    expect(accentMatches).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*id="copy-connector"[^>]*class="[^"]*\bbtn-accent\b/);
  });

  it("redirects GET /connect.html to /connect, so the raw asset is never shown", async () => {
    const res = await SELF.fetch(`${BASE}/connect.html`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/connect");
  });

  it("keeps no hardcoded connector host in the static asset", async () => {
    const res = await env.ASSETS.fetch(new URL("/connect.html", BASE));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("orsko.dev/mcp");
  });

  it("wires the copy button with the shared helper", async () => {
    const res = await env.ASSETS.fetch(new URL("/connect.js", BASE));
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain('startRoom.wireCopy("copy-connector", "connector-url")');
    expect(js).not.toMatch(/=>|\bconst\b|\blet\b/);
  });

  it("says on the landing page that every assistant can join", async () => {
    const res = await env.ASSETS.fetch(new URL("/index.html", BASE));
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain(
      "Works with every assistant. Coding agents with a terminal join directly. ChatGPT, Cursor and other MCP clients join through the Orsko connector. Any assistant, even one with no internet access, can take part through a relay seat on the room page.",
    );
    expect(html).toContain('<a href="/connect">the Orsko connector</a>');
    expect(html).toContain("?format=md");
    expect(html).not.toContain('curl -H "Accept: text/markdown"');
  });
});
