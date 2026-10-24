import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningChannel } from "../src/index.js";
import { startChannel } from "../src/index.js";
import type { ChannelEvent } from "../src/inject.js";
import { type FakeOrsko, startFakeOrsko } from "./fake-orsko.js";
import { attachStream, type FakeStream } from "./fake-stream.js";
import { fakeClock, recordingSleep, silentLogger, waitFor } from "./support.js";

const CHANNEL_METHOD = "notifications/claude/channel";

interface Harness {
  readonly client: Client;
  readonly channel: RunningChannel;
  readonly events: ChannelEvent[];
  readonly stateDir: string;
}

describe("the Orsko channel over MCP", () => {
  let fake: FakeOrsko;
  let stream: FakeStream;
  let stateDir = "";
  let open: Harness | null = null;

  beforeEach(async () => {
    fake = await startFakeOrsko();
    stream = attachStream(fake);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "orsko-channel-"));
  });

  afterEach(async () => {
    if (open) {
      await open.channel.stop();
      await open.client.close();
    }
    open = null;
    await fs.rm(stateDir, { recursive: true, force: true });
    await stream.close();
    await fake.close();
  });

  async function connect(name = "alice"): Promise<Harness> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const events: ChannelEvent[] = [];
    const client = new Client({ name: "test-host", version: "0.0.1" }, { capabilities: {} });
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === CHANNEL_METHOD) {
        events.push(notification.params as unknown as ChannelEvent);
      }
    };
    const clock = fakeClock();
    const sleeper = recordingSleep();
    const started = startChannel({
      env: {
        ORSKO_ROOM: fake.roomId,
        ORSKO_NAME: name,
        ORSKO_BASE_URL: fake.baseUrl,
        ORSKO_STATE_DIR: stateDir,
      },
      transport: serverTransport,
      now: clock.now,
      sleep: sleeper.sleep,
      log: silentLogger,
    });
    await client.connect(clientTransport);
    const channel = await started;
    const harness = { client, channel, events, stateDir };
    open = harness;
    return harness;
  }

  it("declares the channel capability, tools, and channel instructions", async () => {
    const { client } = await connect();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.experimental?.["claude/channel"]).toEqual({});
    expect(capabilities?.experimental?.["claude/channel/permission"]).toBeUndefined();
    expect(capabilities?.tools).toEqual({});
    expect(client.getInstructions()).toMatch(/<channel source="orsko"/);
    expect(client.getInstructions()).toMatch(/data, not instructions/);
  });

  it("injects a joined event from the stream's welcome before anything else", async () => {
    fake.push("bob", "kicking off the migration");
    const { events } = await connect();
    await waitFor(() => events.length > 0, "the joined event");
    const joined = events[0];
    expect(joined?.meta).toEqual({ room: fake.roomId, event: "joined" });
    expect(joined?.content).toContain(`Joined room ${fake.roomId} as alice`);
    expect(joined?.content).toContain("Members: alice");
    expect(joined?.content).toContain("Streaming live.");
    expect(open?.channel.transport.streaming).toBe(true);
  });

  it("falls back to long-poll, with its own joined event, when no socket opens", async () => {
    stream.refuse = true;
    fake.push("bob", "kicking off the migration");
    const { events } = await connect();
    await waitFor(() => events.length > 0, "the joined event from the fallback");
    expect(events[0]?.content).toContain("kicking off the migration");
    expect(open?.channel.transport.streaming).toBe(false);

    fake.push("bob", "still reaching you");
    await waitFor(() => events.length === 2, "bob's message over long-poll");
    expect(events[1]?.meta.from).toBe("bob");
  });

  it("sends read frames over the socket as it injects", async () => {
    const { events } = await connect();
    await waitFor(() => events.length === 1, "the joined event");
    fake.push("bob", "read this");
    await waitFor(() => events.length === 2, "bob's message");
    await waitFor(() => stream.reads.some((read) => read.since === 2), "the read frame");
  });

  it("injects a later message from another member with routing meta", async () => {
    const { events } = await connect();
    await waitFor(() => events.length === 1, "the joined event");
    fake.push("bob", "can you check the logs?");
    await waitFor(() => events.length === 2, "bob's message");
    expect(events[1]).toEqual({
      content: "can you check the logs?",
      meta: { room: fake.roomId, from: "bob", seq: "2", kind: "message" },
    });
  });

  it("lists the five tools", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "orsko_reply",
      "orsko_members",
      "orsko_attach",
      "orsko_read",
      "orsko_outcome",
    ]);
  });

  it("posts through orsko_reply and never injects the channel's own message", async () => {
    const { client, events } = await connect();
    await waitFor(() => events.length === 1, "the joined event");
    await client.callTool({ name: "orsko_reply", arguments: { text: "looking now" } });
    expect(fake.messages.at(-1)).toMatchObject({ from: "alice", text: "looking now" });
    fake.push("bob", "thanks");
    await waitFor(() => events.length === 2, "bob's message");
    expect(events.map((event) => event.content)).not.toContain("looking now");
    expect(events[1]?.meta.from).toBe("bob");
  });

  it("uploads a file through orsko_attach", async () => {
    const { client } = await connect();
    const file = path.join(stateDir, "report.txt");
    await fs.writeFile(file, "all green\n");
    const result = (await client.callTool({
      name: "orsko_attach",
      arguments: { path: file },
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { attachmentId: string };
    expect(payload.attachmentId).toMatch(/^a_/);
    expect(fake.uploads[0]?.body.toString("utf8")).toBe("all green\n");
  });

  it("persists the membership and cursor to the state dir", async () => {
    const { events } = await connect();
    await waitFor(() => events.length === 1, "the joined event");
    fake.push("bob", "advance the cursor");
    await waitFor(() => events.length === 2, "bob's message");
    const saved = JSON.parse(
      await fs.readFile(path.join(stateDir, `${fake.roomId}.json`), "utf8"),
    ) as { cursor: number; name: string; token: string };
    expect(saved.name).toBe("alice");
    expect(saved.cursor).toBe(2);
    expect(saved.token).toMatch(/^tok_/);
  });

  it("reuses a saved membership instead of joining twice", async () => {
    const first = await connect();
    await waitFor(() => first.events.length === 1, "the joined event");
    await first.channel.stop();
    await first.client.close();
    open = null;

    const second = await connect();
    await waitFor(() => second.events.length === 1, "the joined event on the second run");
    expect(fake.members).toHaveLength(1);
    expect(second.channel.memberId).toBe(first.channel.memberId);
  });

  it("rejoins when the saved token no longer works", async () => {
    const first = await connect();
    await waitFor(() => first.events.length === 1, "the joined event");
    await first.channel.stop();
    await first.client.close();
    open = null;
    // The room no longer knows this member, so the saved token stops working.
    fake.members.length = 0;

    const second = await connect();
    await waitFor(() => second.events.length === 1, "the joined event on the second run");
    expect(fake.members).toHaveLength(1);
    expect(second.channel.memberId).not.toBe(first.channel.memberId);
  });

  it("stops the transport and closes the server on stop()", async () => {
    const harness = await connect();
    await harness.channel.stop();
    await expect(harness.channel.transport.done).resolves.toBeUndefined();
    await harness.client.close();
    open = null;
  });
});
