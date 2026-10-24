import { describe, expect, it } from "vitest";
import { fillConnectPage } from "../../src/http/room-html";
import { elementText } from "../html";

const FIXTURE = `<!doctype html><html><body>
<pre id="connector-url">PLACEHOLDER</pre>
<pre id="connector-cmd">claude mcp add --transport http orsko PLACEHOLDER</pre>
<pre id="connector-cursor-json">{
  "mcpServers": {
    "orsko": { "url": "PLACEHOLDER" }
  }
}</pre>
</body></html>`;

describe("fillConnectPage", () => {
  it("fills all three elements from the given connector URL", async () => {
    const filled = fillConnectPage(new Response(FIXTURE), "https://example.test/mcp");
    const html = await filled.text();
    expect(elementText(html, "connector-url")).toBe("https://example.test/mcp");
    expect(elementText(html, "connector-cmd")).toBe(
      "claude mcp add --transport http orsko https://example.test/mcp",
    );
    expect(elementText(html, "connector-cursor-json")).toContain(
      '"url": "https://example.test/mcp"',
    );
    expect(html).not.toContain("orsko.dev");
    expect(html).not.toContain("PLACEHOLDER");
  });

  it("escapes HTML-special characters in the connector URL as text", async () => {
    const filled = fillConnectPage(new Response(FIXTURE), "https://example.test/mcp?a=1&b=<x>");
    const html = await filled.text();
    // HTMLRewriter's text insertion escapes the raw markup characters.
    expect(html).toContain("&amp;b=");
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("&b=<x>");
    expect(elementText(html, "connector-url")).toBe("https://example.test/mcp?a=1&b=<x>");
  });

  it("sets the html content type on the response", async () => {
    const filled = fillConnectPage(new Response(FIXTURE), "https://example.test/mcp");
    expect(filled.headers.get("content-type")).toContain("text/html");
  });
});
