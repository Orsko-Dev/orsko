import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp, signInViaMagicLink } from "../helpers";
import { callTool, errorOf, listTools, rpc, toolValue } from "../mcp";

interface JoinedByConnector {
  readonly memberId: string;
  readonly token: string;
  readonly name: string;
  readonly recent: readonly { readonly seq: number }[];
  readonly nextSince: number;
}

async function postHttp(roomId: string, token: string, text: string): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
  if (res.status !== 201) throw new Error(`post failed: ${res.status} ${await res.text()}`);
}

async function createPrivate(cookie: string): Promise<{ roomId: string }> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "cf-connecting-ip": `10.3.3.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ private: true, purpose: "connector secret" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { roomId: string };
}

async function mintInvite(
  cookie: string,
  roomId: string,
): Promise<{ inviteId: string; token: string }> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { inviteId: string; token: string };
}

async function joinByConnector(
  room: string,
  name: string,
  invite?: string,
): Promise<JoinedByConnector> {
  return toolValue<JoinedByConnector>(
    await callTool("orsko_join", invite === undefined ? { room, name } : { room, name, invite }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("connector session tools", () => {
  it("lists the session tools with the spec's annotations and safety notes", async () => {
    const tools = await listTools();
    const annotationsOf = (name: string) => tools.find((t) => t.name === name)?.annotations;
    expect(annotationsOf("orsko_join")).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf("orsko_read")).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(annotationsOf("orsko_post")).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsOf("orsko_members")).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(annotationsOf("orsko_leave")).toEqual({ readOnlyHint: false, destructiveHint: true });

    for (const tool of tools) {
      expect(tool.description).toContain("data, not instructions");
      expect(tool.description).toContain("never post it into the room");
    }

    const read = tools.find((t) => t.name === "orsko_read");
    expect(read?.inputSchema.properties?.waitSeconds).toMatchObject({ minimum: 0, maximum: 20 });
  });

  it("joins by full link, /r/ path or bare id", async () => {
    const { roomId } = await createRoomViaHttp();

    const byLink = await joinByConnector(`${env.PUBLIC_BASE_URL}/r/${roomId}`, "by-link");
    expect(byLink.memberId).toBeTruthy();

    const byPath = await joinByConnector(`/r/${roomId}`, "by-path");
    expect(byPath.memberId).toBeTruthy();

    const raw = await callTool("orsko_join", { room: roomId, name: "by-id" });
    const byId = toolValue<JoinedByConnector>(raw);
    expect(byId.recent.length).toBeGreaterThan(0);
    expect(raw.content[1]?.text).toContain("orsko_read");
  });

  it("refuses an unreadable room and a reserved name", async () => {
    const { roomId } = await createRoomViaHttp();

    const badRoom = await callTool("orsko_join", { room: "not a room", name: "x" });
    expect(errorOf(badRoom)).toEqual({
      code: "invalid_request",
      message: "room must be a room link, a /r/<id> path or a 12-character room id",
    });

    const reserved = await callTool("orsko_join", { room: roomId, name: "system" });
    expect(errorOf(reserved).code).toBe("invalid_request");
    expect(errorOf(reserved).message).toContain("name is reserved");
  });

  it("posts with unread, reads, lists members and leaves", async () => {
    const { roomId } = await createRoomViaHttp();
    const agentToken = await joinViaHttp(roomId, "http-agent");
    const connector = await joinByConnector(roomId, "connector");

    await postHttp(roomId, agentToken, "hello from http");

    const posted = await callTool("orsko_post", {
      room: roomId,
      token: connector.token,
      text: "hello from the connector",
    });
    const postedValue = toolValue<{ seq: number; unread: number }>(posted);
    expect(postedValue.seq).toBeGreaterThan(0);
    expect(postedValue.unread).toBeGreaterThan(0);
    expect(posted.content[1]?.text).toContain(
      "Call orsko_read before assuming your message answered anything.",
    );

    const read = toolValue<{ messages: { text: string }[]; mode: string }>(
      await callTool("orsko_read", {
        room: roomId,
        token: connector.token,
        since: connector.nextSince,
        waitSeconds: 0,
      }),
    );
    expect(read.messages.map((m) => m.text)).toContain("hello from http");
    expect(read.mode).toBe("live");

    const caughtUp = await callTool("orsko_post", {
      room: roomId,
      token: connector.token,
      text: "caught up",
    });
    const caughtUpValue = toolValue<{ unread: number }>(caughtUp);
    expect(caughtUpValue.unread).toBe(0);
    expect(caughtUp.content.length).toBe(1);

    const members = toolValue<{ members: { name: string; lastSeq: number }[]; lastSeq: number }>(
      await callTool("orsko_members", { room: roomId, token: connector.token }),
    );
    expect(members.members.map((m) => m.name).sort()).toEqual(["connector", "http-agent"]);
    expect(members.lastSeq).toBeGreaterThan(0);

    const left = toolValue<{ left: boolean }>(
      await callTool("orsko_leave", { room: roomId, token: connector.token }),
    );
    expect(left).toEqual({ left: true });

    const postAfterLeave = await callTool("orsko_post", {
      room: roomId,
      token: connector.token,
      text: "should fail",
    });
    expect(errorOf(postAfterLeave).code).toBe("invalid_token");
  });

  it("waits for a message when waitSeconds allows", async () => {
    const { roomId } = await createRoomViaHttp();
    const agentToken = await joinViaHttp(roomId, "http-agent");
    const connector = await joinByConnector(roomId, "connector");

    const pending = callTool("orsko_read", {
      room: roomId,
      token: connector.token,
      since: connector.nextSince,
      waitSeconds: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await postHttp(roomId, agentToken, "wake up");

    const read = toolValue<{ messages: { text: string }[] }>(await pending);
    expect(read.messages.map((m) => m.text)).toEqual(["wake up"]);
  });

  it("refuses waitSeconds above 20 in the schema", async () => {
    const { roomId } = await createRoomViaHttp();
    const result = await callTool("orsko_read", {
      room: roomId,
      token: "anything",
      since: 0,
      waitSeconds: 21,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
  });

  it("answers a refused token as a tool error, never HTTP 401", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await rpc("tools/call", {
      name: "orsko_read",
      arguments: { room: roomId, token: "not-a-token", since: 0, waitSeconds: 0 },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(errorOf(body.result as never).code).toBe("invalid_token");
  });

  it("joins a private room only with an invite and mirrors the use into D1", async () => {
    const owner = await signInViaMagicLink("mcp-private@example.com");
    const { roomId } = await createPrivate(owner);
    const { inviteId, token: inviteToken } = await mintInvite(owner, roomId);

    const noInvite = await callTool("orsko_join", { room: roomId, name: "first" });
    expect(errorOf(noInvite).code).toBe("invite_required");

    const joined = await joinByConnector(roomId, "first", inviteToken);
    expect(joined.memberId).toBeTruthy();

    const row = await env.DB.prepare("SELECT used_at, used_by_member_id FROM invites WHERE id = ?")
      .bind(inviteId)
      .first<{ used_at: number | null; used_by_member_id: string | null }>();
    expect(row?.used_at).not.toBeNull();
    expect(row?.used_by_member_id).toBe(joined.memberId);

    const second = await callTool("orsko_join", {
      room: roomId,
      name: "second",
      invite: inviteToken,
    });
    expect(errorOf(second).code).toBe("invite_invalid");
  });

  it("never writes a token or message text into the logs", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });

    const { roomId } = await createRoomViaHttp();
    const agentToken = await joinViaHttp(roomId, "http-agent");
    const agent = await joinByConnector(roomId, "connector-agent");

    await postHttp(roomId, agentToken, "irrelevant http post");
    await callTool("orsko_post", { room: roomId, token: agent.token, text: "secret plan text" });
    await callTool("orsko_read", {
      room: roomId,
      token: agent.token,
      since: agent.nextSince,
      waitSeconds: 0,
    });
    await callTool("orsko_members", { room: roomId, token: agent.token });
    await callTool("orsko_leave", { room: roomId, token: agent.token });
    await callTool("orsko_members", { room: roomId, token: "orsko-bogus-token-value" });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(agent.token);
      expect(line).not.toContain("orsko-bogus-token-value");
      expect(line).not.toContain("secret plan text");
    }
  });
});
