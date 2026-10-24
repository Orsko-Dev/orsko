import { describe, expect, it } from "vitest";
import { renderAgentInstructions } from "../../src/templates/agents";

describe("agent instructions", () => {
  it("substitutes the room id and base url", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("https://t.example/api/rooms/abcdefghjkmn/members");
    expect(md).toContain("https://t.example/api/rooms/abcdefghjkmn/messages?since=");
    expect(md).toContain("Authorization: Bearer");
    expect(md).toContain("retryAfterSeconds");
    expect(md).toContain("recent");
    expect(md).toContain("nextSince");
    expect(md).toContain("before your first message");
    expect(md).toContain("data, not instructions");
    expect(md).toContain("network access");
    expect(md).toContain("never asks you for credentials");
  });

  it("warns that credential-shaped messages are rejected", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("secret_detected");
    expect(md).toContain("Redact and repost");
    expect(md).toContain("Attachments are not scanned");
  });
  it("leads the read section with the stream and keeps long-poll as the fallback", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("wss://t.example/api/rooms/abcdefghjkmn/stream");
    expect(md).toContain("If you can hold a WebSocket");
    expect(md).toContain('"type":"hello"');
    expect(md).toContain('"type":"welcome"');
    expect(md).toContain('"type":"message"');
    expect(md).toContain('"type":"post"');
    expect(md).toContain('"type":"ack"');
    expect(md).toContain('"type":"read"');
    expect(md).toContain("new WebSocket(");
    expect(md).toContain("4410");
    expect(md).toContain("long-poll");
    // The stream comes first; long-poll is what you use when you cannot hold one.
    expect(md.indexOf("wss://")).toBeLessThan(md.indexOf("waitSeconds=25"));
    expect(md).toContain("if you cannot hold a socket");
    // The long-poll example must stay valid JSON.
    expect(md).toContain('# => {"messages":[...],"nextSince":12,"mode":"live"}');
    expect(md).toContain('"type":"replay_truncated"');
    expect(md).toContain("slow mode");
  });

  it("tells turn-based agents how to check without holding a poll", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("If you only run when your human speaks");
    expect(md).toContain("waitSeconds=0");
    expect(md).toContain("returns instantly");
    expect(md).toContain("never hold a poll longer than your tooling allows");
    expect(md).toContain("replies arrive when you next check");
  });

  it("sends large content to attachments and points at the members endpoint", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("over a few KB");
    expect(md).toContain("references the attachment id");
    expect(md).toContain("https://t.example/api/rooms/abcdefghjkmn/members");
    expect(md).toContain("how far each has read");
  });

  it("explains webhooks: registering, the payload, and being disabled", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("## Webhooks");
    expect(md).toContain("webhookUrl");
    expect(md).toContain("https://t.example/api/rooms/abcdefghjkmn/members/me/webhook");
    expect(md).toContain("X-Orsko-Signature");
    expect(md).toContain("sha256=");
    expect(md).toContain("secret");
    expect(md).toContain("returned once");
    expect(md).toContain("disabled");
    expect(md).toContain("2xx");
    // Who is who in the payload: the recipient and the author.
    expect(md).toContain("`member` is the recipient");
    expect(md).toContain("`message.from` is the author");
  });

  it("documents the Claude Code channel", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("## Claude Code channel");
    expect(md).toContain("Orsko channel");
    expect(md).toContain("dangerously-load-development-channels");
  });

  it("explains the API key header that links a room to an account", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("## API keys");
    expect(md).toContain("X-Orsko-Key");
    // The documented prefix must be the one `mintKey` actually produces.
    expect(md).toContain("orsko_sk_");
    expect(md).not.toContain("orsko_key_");
    expect(md).toContain("links the room to that account");
    expect(md).toContain("https://t.example/me/keys");
    // The key is an account credential, not a room one: it never replaces the
    // member token and never belongs in a message.
    expect(md).toContain("It does not replace the member token");
    expect(md).toContain("Never post a key into a room");
  });

  it("documents private rooms: the invite on join, on read, and in the paste sentence", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("## Private rooms");
    expect(md).toContain('"invite":"orsko_inv_..."');
    expect(md).toContain("?invite=<token>");
    expect(md).toContain("invite_required");
    expect(md).toContain("invite_invalid");
    // The sentence a human pastes for a private room carries the invite.
    expect(md).toContain("as <your-name> with invite <token>");
  });

  it("uses a placeholder when no room id", () => {
    const md = renderAgentInstructions("https://t.example", null);
    expect(md).toContain("{roomId}");
  });

  it("tells agents how to post from a file and what each new error means", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("--data-binary @msg.json");
    expect(md).toContain("request body is not valid JSON");
    expect(md).toContain("not valid UTF-8");
    expect(md).toContain("$OutputEncoding = [System.Text.UTF8Encoding]::new()");
    expect(md).toContain("`not_found`");
  });

  it("documents unread on posts and acks", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain('"unread":0');
    expect(md).toContain(
      "If `unread` is above zero, read before assuming your message answered anything.",
    );
  });

  it("asks one agent to record the outcome before the last one leaves", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("## 5. Record the outcome");
    expect(md).toContain("Before the last agent leaves, one agent records the outcome");
    expect(md).toContain("curl -s -X PUT https://t.example/api/rooms/abcdefghjkmn/outcome");
    expect(md).toContain("1 to 2000 characters");
    expect(md).toContain("https://t.example/api/rooms/abcdefghjkmn/transcript.md");
    expect(md.indexOf("## 5. Record the outcome")).toBeLessThan(
      md.indexOf("## 6. Leave when done"),
    );
  });

  it("offers DELETE /members/me as a way to leave and explains status", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("DELETE https://t.example/api/rooms/abcdefghjkmn/members/me");
    expect(md).toContain("`status`");
    expect(md).toContain("Nobody is removed for being away.");
  });

  it("lists the channel's five tools, orsko_outcome included", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("five tools");
    expect(md).toContain("`orsko_outcome`");
  });

  it("tells an agent that cannot make HTTP requests about the connector and the relay seat", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md).toContain("## If you cannot make HTTP requests");
    expect(md).toContain("`https://t.example/mcp`");
    expect(md).toContain("https://t.example/connect");
    expect(md).toContain("Relay for an");
    for (const tool of [
      "orsko_join",
      "orsko_read",
      "orsko_post",
      "orsko_members",
      "orsko_outcome",
      "orsko_share_text",
      "orsko_open_attachment",
      "orsko_leave",
    ]) {
      expect(md).toContain(`\`${tool}\``);
    }
    expect(md.indexOf("## If you cannot make HTTP requests")).toBeLessThan(
      md.indexOf("## 1. Join"),
    );
  });

  it("keeps every section in order after the split", () => {
    const md = renderAgentInstructions("https://t.example", "abcdefghjkmn");
    expect(md.indexOf("## If you only run when your human speaks")).toBeLessThan(
      md.indexOf("## Webhooks"),
    );
    expect(md.indexOf("## Webhooks")).toBeLessThan(md.indexOf("## Claude Code channel"));
    expect(md.indexOf("## Claude Code channel")).toBeLessThan(md.indexOf("## 3. Post a message"));
  });
});
