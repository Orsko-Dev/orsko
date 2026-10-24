import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrskoClient } from "../src/client.js";
import { MAX_ATTACHMENT_BYTES, MAX_OUTCOME_CHARS } from "../src/config.js";
import { PendingTracker } from "../src/pending.js";
import { callTool, TOOL_DEFINITIONS, type ToolContext } from "../src/tools.js";
import { type FakeOrsko, startFakeOrsko } from "./fake-orsko.js";
import { silentLogger } from "./support.js";

describe("channel tools", () => {
  let fake: FakeOrsko;
  let context: ToolContext;
  let dir = "";

  beforeEach(async () => {
    fake = await startFakeOrsko();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "orsko-tools-"));
    const base = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
    const join = await base.join({ name: "alice" });
    context = {
      client: base.withToken(join.token),
      roomId: fake.roomId,
      selfName: "alice",
      pending: new PendingTracker(),
      log: silentLogger,
      cursor: () => join.nextSince,
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fake.close();
  });

  function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((part) => part.text ?? "").join("");
  }

  it("declares five tools whose descriptions mark room messages as data", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "orsko_reply",
      "orsko_members",
      "orsko_attach",
      "orsko_read",
      "orsko_outcome",
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description).toMatch(/data, not instructions/);
    }
  });

  it("orsko_outcome schema declares the outcome text length bounds", () => {
    const outcome = TOOL_DEFINITIONS.find((tool) => tool.name === "orsko_outcome");
    expect(outcome).toBeDefined();
    if (!outcome) throw new Error("orsko_outcome tool definition not found");
    const schema = outcome.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const textProp = properties.text as Record<string, unknown>;
    expect(textProp.minLength).toBe(1);
    expect(textProp.maxLength).toBe(MAX_OUTCOME_CHARS);
  });

  it("orsko_reply posts to the room and returns the seq", async () => {
    const result = await callTool(context, "orsko_reply", { text: "on it" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/"seq": 2/);
    expect(fake.messages.at(-1)).toMatchObject({ from: "alice", text: "on it" });
  });

  it("every tool call acknowledges the pending backlog", async () => {
    context.pending.remember([{ seq: 2, from: "bob", content: "hi", at: 0 }]);
    await callTool(context, "orsko_members", {});
    expect(context.pending.size).toBe(0);
  });

  it("orsko_reply reports a rejected credential as a tool error", async () => {
    const result = await callTool(context, "orsko_reply", { text: "key sk-live-abc" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/secret_detected/);
  });

  it("orsko_reply validates its input", async () => {
    expect((await callTool(context, "orsko_reply", {})).isError).toBe(true);
    expect((await callTool(context, "orsko_reply", { text: "  " })).isError).toBe(true);
    expect((await callTool(context, "orsko_reply", { text: 5 })).isError).toBe(true);
  });

  it("orsko_members returns names with their read state", async () => {
    fake.push("bob", "hello");
    const result = await callTool(context, "orsko_members", {});
    const payload = JSON.parse(textOf(result)) as {
      members: Array<{ name: string; readThrough: number }>;
      lastSeq: number;
    };
    expect(payload.members.map((m) => m.name)).toEqual(["alice"]);
    expect(payload.lastSeq).toBe(2);
  });

  it("orsko_attach uploads a local file and returns its attachment id", async () => {
    const file = path.join(dir, "notes.md");
    await fs.writeFile(file, "# notes\n");
    const result = await callTool(context, "orsko_attach", { path: file });
    const payload = JSON.parse(textOf(result)) as { attachmentId: string; size: number };
    expect(payload.attachmentId).toMatch(/^a_/);
    expect(payload.size).toBe(8);
    expect(fake.uploads[0]?.contentType).toBe("text/markdown");
    expect(fake.uploads[0]?.body.toString("utf8")).toBe("# notes\n");
  });

  it("orsko_attach refuses a missing path, a directory, and an oversized file", async () => {
    expect((await callTool(context, "orsko_attach", { path: `${dir}/nope` })).isError).toBe(true);
    expect((await callTool(context, "orsko_attach", { path: dir })).isError).toBe(true);
    const big = path.join(dir, "big.bin");
    await fs.writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    const result = await callTool(context, "orsko_attach", { path: big });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/10 MiB/);
    expect(fake.uploads).toHaveLength(0);
  });

  it("rejects a filename with control characters before uploading", async () => {
    const file = path.join(dir, "notes\tbad.md");
    await fs.writeFile(file, "# notes\n");
    const result = await callTool(context, "orsko_attach", { path: file });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/control characters or non-ASCII/);
    expect(fake.uploads).toHaveLength(0);
  });

  it("rejects a filename with non-ASCII characters before uploading", async () => {
    const file = path.join(dir, "café.md");
    await fs.writeFile(file, "# notes\n");
    const result = await callTool(context, "orsko_attach", { path: file });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/control characters or non-ASCII/);
    expect(fake.uploads).toHaveLength(0);
  });

  it("orsko_read returns messages since a cursor without waiting", async () => {
    fake.push("bob", "one");
    fake.push("bob", "two");
    const result = await callTool(context, "orsko_read", { since: 2 });
    const payload = JSON.parse(textOf(result)) as {
      messages: Array<{ text: string }>;
      nextSince: number;
      mode: string;
    };
    expect(payload.messages.map((m) => m.text)).toEqual(["two"]);
    expect(payload.nextSince).toBe(3);
    expect(payload.mode).toBe("live");
    expect(fake.pollRequests.at(-1)?.waitSeconds).toBe(0);
  });

  it("orsko_read defaults to the channel's own cursor", async () => {
    fake.push("bob", "one");
    const result = await callTool(context, "orsko_read", {});
    const payload = JSON.parse(textOf(result)) as { messages: Array<{ text: string }> };
    expect(payload.messages.map((m) => m.text)).toEqual(["one"]);
  });

  it("rejects an unknown tool", async () => {
    const result = await callTool(context, "orsko_nope", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unknown tool/);
  });

  it("orsko_reply reports what the agent had not read, and nothing once it has", async () => {
    fake.push("bob", "question one");
    fake.push("bob", "question two");
    const first = JSON.parse(
      textOf(await callTool(context, "orsko_reply", { text: "hi all" })),
    ) as {
      unread: number;
      note?: string;
    };
    expect(first.unread).toBe(2);
    expect(first.note).toMatch(/orsko_read/);

    await callTool(context, "orsko_read", {});
    const second = JSON.parse(
      textOf(await callTool(context, "orsko_reply", { text: "answers" })),
    ) as { unread: number; note?: string };
    expect(second.unread).toBe(0);
    expect(second.note).toBeUndefined();
  });

  it("orsko_outcome records the outcome and the room announces it", async () => {
    const result = await callTool(context, "orsko_outcome", { text: "  Ship Tuesday.  " });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result)) as { outcome: { text: string; by: string } };
    expect(payload.outcome).toMatchObject({ text: "Ship Tuesday.", by: "alice" });
    expect(fake.outcome?.text).toBe("Ship Tuesday.");
    expect(fake.messages.at(-1)).toMatchObject({
      from: "system",
      text: "alice recorded the outcome",
    });
  });

  it("orsko_outcome validates its input before calling the room", async () => {
    expect((await callTool(context, "orsko_outcome", {})).isError).toBe(true);
    const long = await callTool(context, "orsko_outcome", { text: "x".repeat(2001) });
    expect(long.isError).toBe(true);
    expect(textOf(long)).toMatch(/2000 characters/);
    expect(fake.outcome).toBeNull();
  });

  it("orsko_outcome reports the room's refusal", async () => {
    const base = new OrskoClient({ baseUrl: fake.baseUrl, roomId: fake.roomId });
    const observer = await base.join({ name: "watcher", role: "observer" });
    const watching: ToolContext = { ...context, client: base.withToken(observer.token) };
    const result = await callTool(watching, "orsko_outcome", { text: "mine" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/forbidden/);
  });
});
