import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIERS } from "../../src/config/tiers";
import { attachmentKey } from "../../src/room/archive";
import { generateRoomId } from "../../src/util/ids";
import { authHeaders, BASE, createRoomViaHttp, joinViaHttp, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

function exportOf(roomId: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript.md`, { headers });
}

async function archive(roomId: string): Promise<void> {
  const stub = env.ROOM.getByName(roomId);
  await stub.forceState("slow", Date.now() - (TIERS.free.idleToArchiveSeconds + 1) * 1000);
  await runDurableObjectAlarm(stub);
}

async function postText(roomId: string, token: string, text: string): Promise<void> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(201);
}

describe("GET /transcript.md", () => {
  it("needs a member token for a live room and then serves markdown", async () => {
    const { roomId } = await createRoomViaHttp("export test");
    const alice = await joinViaHttp(roomId, "alice");
    await postText(roomId, alice, "the plan is ready");
    await SELF.fetch(`${BASE}/api/rooms/${roomId}/outcome`, {
      method: "PUT",
      headers: authHeaders(alice),
      body: JSON.stringify({ text: "ship it" }),
    });

    expect((await exportOf(roomId)).status).toBe(401);
    const res = await exportOf(roomId, authHeaders(alice));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="orsko-${roomId}.md"`,
    );
    const md = await res.text();
    expect(md.startsWith(`# Orsko room ${roomId}\n`)).toBe(true);
    expect(md).toContain("Purpose:\n\n```\nexport test\n```");
    expect(md).toContain("## Outcome\n\n```\nship it\n```\n\nRecorded by alice at ");
    expect(md).toContain("- alice (agent), joined ");
    expect(md).toContain("**alice** · 2 · ");
    expect(md).toContain("the plan is ready");
    expect(md).toContain("**system** · 3 · ");
  });

  it("lists attachment ids under their message", async () => {
    const roomId = generateRoomId();
    const stub = env.ROOM.getByName(roomId);
    await stub.create({ roomId, purpose: null, tier: "free" });
    const alice = await stub.join({ name: "alice", role: "agent" });
    if (!alice.ok) throw new Error("join failed");
    const upload = await stub.authorizeUpload(alice.value.token, {
      filename: "fix.diff",
      size: 4,
      contentType: "text/plain",
    });
    if (!upload.ok) throw new Error("authorize failed");
    const { attachmentId } = upload.value;
    await env.ARCHIVE.put(attachmentKey("free", roomId, attachmentId, "live"), "diff");
    await stub.recordAttachment(alice.value.token, {
      attachmentId,
      filename: "fix.diff",
      size: 4,
      contentType: "text/plain",
    });
    await stub.postMessage(alice.value.token, {
      text: "see the diff",
      attachmentIds: [attachmentId],
    });
    const md = await (await exportOf(roomId, authHeaders(alice.value.token))).text();
    expect(md).toContain(`see the diff\n\`\`\`\n\nAttachments: ${attachmentId}\n`);
  });

  it("serves an archived public room to the link alone, departed members included", async () => {
    const { roomId } = await createRoomViaHttp();
    const alice = await joinViaHttp(roomId, "alice");
    const bob = await joinViaHttp(roomId, "bob");
    await postText(roomId, bob, "signing off");
    await SELF.fetch(`${BASE}/api/rooms/${roomId}/leave`, {
      method: "POST",
      headers: authHeaders(bob),
    });
    await postText(roomId, alice, "wrapping up");
    await archive(roomId);

    const res = await exportOf(roomId);
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toMatch(/- bob \(agent\), joined \S+, left \S+/);
    expect(md).toContain("signing off");
    expect(md).toContain("wrapping up");
  });

  it("keeps a private room behind the same gate as the transcript", async () => {
    const owner = await signInViaMagicLink("export-own@example.com");
    const create = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "cf-connecting-ip": `10.4.4.${Math.floor(Math.random() * 250)}`,
      },
      body: JSON.stringify({ private: true }),
    });
    const { roomId } = (await create.json()) as { roomId: string };
    expect((await exportOf(roomId)).status).toBe(403);
    // Live: the owner's session passes the privacy gate, but reading a live
    // transcript still needs a member token, exactly as GET /transcript does.
    expect((await exportOf(roomId, { cookie: owner })).status).toBe(401);
    await archive(roomId);
    expect((await exportOf(roomId)).status).toBe(403);
    expect((await exportOf(roomId, { cookie: owner })).status).toBe(200);
  });

  it("404s for a room that does not exist", async () => {
    expect((await exportOf("abcdefghjkmn")).status).toBe(404);
  });
});
