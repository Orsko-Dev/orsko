/**
 * Fills the room page before any script runs, so a browsing or fetch tool
 * that never executes JavaScript still receives the paste sentence, the link
 * to the markdown instructions and the instructions themselves. Every value
 * goes in as text, which HTMLRewriter escapes; nothing is inserted as markup.
 */

export interface RoomPageFill {
  /** What `#paste` shows: the sentence, or the hint a private room shows instead. */
  readonly pasteText: string;
  /** The invite-less sentence, kept for the room view if the owner makes the room public. */
  readonly publicSentence: string;
  /** Where `#md-link` points. */
  readonly markdownHref: string;
  /** The full markdown instructions, for `#agent-instructions`. */
  readonly instructions: string;
}

function textInto(text: string): HTMLRewriterElementContentHandlers {
  return {
    element(element) {
      element.setInnerContent(text, { html: false });
    },
  };
}

export function fillRoomPage(page: Response, fill: RoomPageFill): Response {
  const rewritten = new HTMLRewriter()
    .on("#paste", textInto(fill.pasteText))
    .on("#paste-sentence", textInto(fill.publicSentence))
    .on("#agent-instructions", textInto(fill.instructions))
    .on("#md-link", {
      element(element) {
        element.setAttribute("href", fill.markdownHref);
      },
    })
    .transform(page);
  return new Response(rewritten.body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Fills the connector setup page with the real connector URL, built from
 * `PUBLIC_BASE_URL` rather than shipped as a hardcoded production host in the
 * static asset. Every occurrence on the page — the copyable URL, the Claude
 * Code command and the Cursor config snippet — is filled from the same value.
 */
export function fillConnectPage(page: Response, connectorUrl: string): Response {
  const cursorJson = `{
  "mcpServers": {
    "orsko": { "url": "${connectorUrl}" }
  }
}`;
  // Claude Desktop reaches this server through the mcp-remote bridge: claude.ai's
  // connector flow demands an OAuth sign-in service that an authless server has no
  // reason to run (anthropics/claude-ai-mcp#457, closed as not planned).
  const desktopJson = `{
  "mcpServers": {
    "orsko": { "command": "npx", "args": ["-y", "mcp-remote", "${connectorUrl}"] }
  }
}`;
  const rewritten = new HTMLRewriter()
    .on("#connector-url", textInto(connectorUrl))
    .on("#connector-cmd", textInto(`claude mcp add --transport http orsko ${connectorUrl}`))
    .on("#connector-cursor-json", textInto(cursorJson))
    .on("#connector-desktop-json", textInto(desktopJson))
    .transform(page);
  return new Response(rewritten.body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
