import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomObject } from "../../src/room/RoomObject";
import { BASE, signInViaMagicLink } from "../helpers";

afterEach(() => vi.restoreAllMocks());

interface InviteListRow {
  readonly inviteId: string;
  readonly label: string | null;
  readonly addressedEmail: string | null;
  readonly addressedGithubLogin: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: string;
}

async function createPrivate(cookie: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "cf-connecting-ip": `10.3.3.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ private: true }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { roomId: string }).roomId;
}

async function mint(cookie: string, roomId: string, body: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

async function mintToken(cookie: string, roomId: string, body: Record<string, string> = {}) {
  const res = await mint(cookie, roomId, body);
  expect(res.status).toBe(201);
  return (await res.json()) as { inviteId: string; token: string; expiresAt: number };
}

async function listInvites(cookie: string, roomId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, { headers: { cookie } });
}

async function joinWith(roomId: string, name: string, invite?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invite === undefined ? { name } : { name, invite }),
  });
}

/** Pulls one invite's expiry into the past, in the room object and in D1. */
async function expireInvite(roomId: string, inviteId: string): Promise<void> {
  const stub = env.ROOM.getByName(roomId);
  await runInDurableObject(stub, (instance: RoomObject) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    sql.exec("UPDATE invites SET expires_at = 1 WHERE invite_id = ?", inviteId);
  });
  await env.DB.prepare("UPDATE invites SET expires_at = 1 WHERE id = ?").bind(inviteId).run();
}

describe("invites", () => {
  it("lists issued invites and shows them used after a join", async () => {
    const owner = await signInViaMagicLink("inv1@example.com");
    const roomId = await createPrivate(owner);
    const { inviteId, token } = await mintToken(owner, roomId, {
      label: "for dana",
      addressedEmail: "dana@example.com",
    });

    const before = (await (await listInvites(owner, roomId)).json()) as {
      invites: InviteListRow[];
    };
    expect(before.invites).toHaveLength(1);
    expect(before.invites[0]?.inviteId).toBe(inviteId);
    expect(before.invites[0]?.status).toBe("pending");
    expect(before.invites[0]?.label).toBe("for dana");
    expect(before.invites[0]?.addressedEmail).toBe("dana@example.com");
    // The token itself is never listed back.
    expect(JSON.stringify(before)).not.toContain(token);

    expect((await joinWith(roomId, "dana", token)).status).toBe(201);
    const after = (await (await listInvites(owner, roomId)).json()) as { invites: InviteListRow[] };
    expect(after.invites[0]?.status).toBe("used");
  });

  it("revoking an invite makes the token invalid", async () => {
    const owner = await signInViaMagicLink("inv2@example.com");
    const roomId = await createPrivate(owner);
    const { inviteId, token } = await mintToken(owner, roomId);

    const del = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites/${inviteId}`, {
      method: "DELETE",
      headers: { cookie: owner, "sec-fetch-site": "same-origin" },
    });
    expect(del.status).toBe(204);

    const join = await joinWith(roomId, "late", token);
    expect(join.status).toBe(403);
    expect(((await join.json()) as { error: { code: string } }).error.code).toBe("invite_invalid");

    const list = (await (await listInvites(owner, roomId)).json()) as { invites: InviteListRow[] };
    expect(list.invites[0]?.status).toBe("revoked");
  });

  it("an expired invite is invalid and listed as expired", async () => {
    const owner = await signInViaMagicLink("inv3@example.com");
    const roomId = await createPrivate(owner);
    const { inviteId, token } = await mintToken(owner, roomId);
    await expireInvite(roomId, inviteId);

    const join = await joinWith(roomId, "slow", token);
    expect(join.status).toBe(403);
    expect(((await join.json()) as { error: { code: string } }).error.code).toBe("invite_invalid");

    const list = (await (await listInvites(owner, roomId)).json()) as { invites: InviteListRow[] };
    expect(list.invites[0]?.status).toBe("expired");
  });

  it("only the owner may mint, list or revoke", async () => {
    const owner = await signInViaMagicLink("inv4@example.com");
    const stranger = await signInViaMagicLink("stranger4@example.com");
    const roomId = await createPrivate(owner);
    const { inviteId } = await mintToken(owner, roomId);

    expect((await mint(stranger, roomId)).status).toBe(403);
    expect((await listInvites(stranger, roomId)).status).toBe(403);
    const del = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites/${inviteId}`, {
      method: "DELETE",
      headers: { cookie: stranger, "sec-fetch-site": "same-origin" },
    });
    expect(del.status).toBe(403);

    const anon = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anon.status).toBe(401);
  });

  it("rate limits minting per user", async () => {
    const owner = await signInViaMagicLink("inv5@example.com");
    const roomId = await createPrivate(owner);
    // The test environment sets INVITE_MINT_LIMIT_PER_HOUR to 5.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await mint(owner, roomId)).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.at(-1)).toBe(429);
  });

  it("public rooms accept invites nowhere and still join freely", async () => {
    const owner = await signInViaMagicLink("inv6@example.com");
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "cf-connecting-ip": "10.3.4.9",
      },
      body: JSON.stringify({}),
    });
    const { roomId } = (await res.json()) as { roomId: string };
    expect((await joinWith(roomId, "anyone")).status).toBe(201);
    // Minting an invite for a public room is refused: there is nothing to gate.
    expect((await mint(owner, roomId)).status).toBe(400);
  });
});

/**
 * Makes every D1 statement whose SQL contains `match` fail, leaving the rest
 * of the database working. The room object is written before D1 on every one
 * of these paths, so the caller must still get its success response.
 */
function breakD1(match: string): { calls: () => number } {
  const real = env.DB.prepare.bind(env.DB);
  let hits = 0;
  vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(match)) {
      hits += 1;
      throw new Error("D1 is down");
    }
    return real(query);
  });
  return { calls: () => hits };
}

describe("index writes that fail after the room has already been changed", () => {
  it("still admits the member, and spends the invite, when the mirror write fails", async () => {
    const owner = await signInViaMagicLink("d1a@example.com");
    const roomId = await createPrivate(owner);
    const { token } = await mintToken(owner, roomId);

    const broken = breakD1("UPDATE invites SET used_at");
    const join = await joinWith(roomId, "resilient", token);
    expect(broken.calls()).toBeGreaterThan(0);
    expect(join.status).toBe(201);
    expect(((await join.json()) as { token: string }).token).toBeTruthy();

    vi.restoreAllMocks();
    // The invite was spent in the room object regardless, so it is single use.
    expect((await joinWith(roomId, "second", token)).status).toBe(403);
  });

  it("still returns the minted token when the invite row cannot be written", async () => {
    const owner = await signInViaMagicLink("d1b@example.com");
    const roomId = await createPrivate(owner);

    const broken = breakD1("INSERT INTO invites");
    const res = await mint(owner, roomId);
    expect(broken.calls()).toBeGreaterThan(0);
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    expect(token).toContain("orsko_inv_");

    vi.restoreAllMocks();
    // The room object took the invite, so the token works even though the
    // owner's list will not show it until the row is repaired.
    expect((await joinWith(roomId, "unlisted", token)).status).toBe(201);
  });

  it("still admits an invited browser when the mirror write fails", async () => {
    const owner = await signInViaMagicLink("d1c@example.com");
    const roomId = await createPrivate(owner);
    const { token } = await mintToken(owner, roomId);

    const broken = breakD1("UPDATE invites SET used_at");
    const view = await SELF.fetch(`${BASE}/r/${roomId}?invite=${token}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(broken.calls()).toBeGreaterThan(0);
    expect(view.status).toBe(302);
    expect(view.headers.get("location")).toContain("#observer=");
  });
});

describe("invite status after the fact", () => {
  it("keeps a spent invite used even when it is revoked afterwards", async () => {
    const owner = await signInViaMagicLink("inv7@example.com");
    const roomId = await createPrivate(owner);
    const { inviteId, token } = await mintToken(owner, roomId);
    expect((await joinWith(roomId, "spender", token)).status).toBe(201);

    const del = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites/${inviteId}`, {
      method: "DELETE",
      headers: { cookie: owner, "sec-fetch-site": "same-origin" },
    });
    expect(del.status).toBe(204);

    const list = (await (await listInvites(owner, roomId)).json()) as { invites: InviteListRow[] };
    expect(list.invites[0]?.status).toBe("used");
    const row = await env.DB.prepare("SELECT revoked_at FROM invites WHERE id = ?")
      .bind(inviteId)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeNull();
  });
});

describe("invite routes and the privacy toggle require a browser session", () => {
  /** Mints a personal API key for a freshly signed-in user. */
  async function mintApiKey(cookie: string): Promise<string> {
    const res = await SELF.fetch(`${BASE}/api/me/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ label: "agent" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { key: string }).key;
  }

  async function expectKeyRefused(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "unauthorized",
      message: "sign in with your browser to manage invites",
    });
  }

  it("refuses an API key on mint, list, revoke and the privacy flip", async () => {
    const owner = await signInViaMagicLink("keyed@example.com");
    const roomId = await createPrivate(owner);
    const { inviteId } = await mintToken(owner, roomId);
    const key = await mintApiKey(owner);
    const keyed = { "x-orsko-key": key, "sec-fetch-site": "same-origin" };

    await expectKeyRefused(
      await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
        method: "POST",
        headers: { ...keyed, "content-type": "application/json" },
        body: JSON.stringify({ label: "no" }),
      }),
    );
    await expectKeyRefused(
      await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, { headers: keyed }),
    );
    await expectKeyRefused(
      await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites/${inviteId}`, {
        method: "DELETE",
        headers: keyed,
      }),
    );
    await expectKeyRefused(
      await SELF.fetch(`${BASE}/api/rooms/${roomId}/private`, {
        method: "PUT",
        headers: { ...keyed, "content-type": "application/json" },
        body: JSON.stringify({ private: false }),
      }),
    );

    // Nothing was changed by any of the four refusals, and history still
    // accepts the same key.
    const list = (await (await listInvites(owner, roomId)).json()) as { invites: InviteListRow[] };
    expect(list.invites).toHaveLength(1);
    expect(list.invites[0]?.status).toBe("pending");
    const history = await SELF.fetch(`${BASE}/api/me/rooms`, { headers: { "x-orsko-key": key } });
    expect(history.status).toBe(200);
  });
});

describe("cross-site requests to the invite routes", () => {
  it("refuses minting an invite and flipping privacy from another site", async () => {
    const owner = await signInViaMagicLink("cross-inv@example.com");
    const roomId = await createPrivate(owner);

    const crossMint = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
      method: "POST",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ label: "from elsewhere" }),
    });
    expect(crossMint.status).toBe(403);
    expect(((await crossMint.json()) as { error: { code: string } }).error.code).toBe("forbidden");

    const crossFlip = await SELF.fetch(`${BASE}/api/rooms/${roomId}/private`, {
      method: "PUT",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ private: false }),
    });
    expect(crossFlip.status).toBe(403);

    // Neither landed: no invite was issued and the room is still private.
    const list = (await (await listInvites(owner, roomId)).json()) as { invites: InviteListRow[] };
    expect(list.invites).toHaveLength(0);
    const anon = await SELF.fetch(`${BASE}/api/rooms/${roomId}`);
    expect(anon.status).toBe(403);
  });
});
