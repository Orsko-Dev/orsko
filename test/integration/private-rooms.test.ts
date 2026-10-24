import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, joinViaHttp, signInViaMagicLink } from "../helpers";

/**
 * Signs a user in through GitHub, mocking the two GitHub API calls. Returns
 * the session cookie, exactly as the magic-link helper does.
 */
async function signInViaGithub(login: string, email: string): Promise<string> {
  const start = await SELF.fetch(`${BASE}/auth/github`, { redirect: "manual" });
  const stateCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token"))
      return Response.json({ access_token: "gh_tok" });
    if (url === "https://api.github.com/user")
      return Response.json({ id: login.length + 1000, login, name: login, avatar_url: null });
    if (url === "https://api.github.com/user/emails")
      return Response.json([{ email, primary: true, verified: true }]);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  const cb = await SELF.fetch(
    `${BASE}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie: stateCookie }, redirect: "manual" },
  );
  spy.mockRestore();
  return (
    cb.headers
      .getSetCookie()
      .find((v) => v.startsWith("orsko_session="))
      ?.split(";")[0] ?? ""
  );
}

afterEach(() => vi.restoreAllMocks());

async function createPrivate(cookie: string): Promise<{ roomId: string }> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "cf-connecting-ip": `10.2.2.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ private: true, purpose: "secret" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { roomId: string };
}

async function mintInvite(
  cookie: string,
  roomId: string,
  body: Record<string, string> = {},
): Promise<{ inviteId: string; token: string; expiresAt: number; pasteSentence: string }> {
  const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    inviteId: string;
    token: string;
    expiresAt: number;
    pasteSentence: string;
  };
}

async function errorCodeOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("private rooms", () => {
  it("anonymous users cannot create private rooms", async () => {
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ private: true }),
    });
    expect(res.status).toBe(400);
  });

  it("requires an invite to join, accepts a valid one once, and lets the owner in", async () => {
    const owner = await signInViaMagicLink("own@example.com");
    const { roomId } = await createPrivate(owner);

    const noInvite = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob" }),
    });
    expect(noInvite.status).toBe(403);
    expect(await errorCodeOf(noInvite)).toBe("invite_required");

    const { token, pasteSentence } = await mintInvite(owner, roomId, { label: "for bob" });
    expect(pasteSentence).toContain(token);

    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob", invite: token }),
    });
    expect(join.status).toBe(201);

    const reuse = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "carol", invite: token }),
    });
    expect(reuse.status).toBe(403);
    expect(await errorCodeOf(reuse)).toBe("invite_invalid");

    const ownerJoin = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ name: "owner-agent" }),
    });
    expect(ownerJoin.status).toBe(201);
  });

  it("rejects a token that is not an invite at all", async () => {
    const owner = await signInViaMagicLink("own-bad@example.com");
    const { roomId } = await createPrivate(owner);
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mallory", invite: "orsko_inv_notarealtokenatall" }),
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("invite_invalid");
  });

  it("addressed invites link the room into the invitee's history after sign-in", async () => {
    const owner = await signInViaMagicLink("own2@example.com");
    const { roomId } = await createPrivate(owner);
    const { token } = await mintInvite(owner, roomId, { addressedEmail: "late@example.com" });
    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "late-agent", invite: token }),
    });
    expect(join.status).toBe(201);

    const late = await signInViaMagicLink("late@example.com");
    const hist = await SELF.fetch(`${BASE}/api/me/rooms?filter=joined`, {
      headers: { cookie: late },
    });
    const body = (await hist.json()) as { rooms: { roomId: string }[] };
    expect(body.rooms.map((r) => r.roomId)).toContain(roomId);
  });

  it("links a GitHub-addressed invite whatever the case of the login", async () => {
    const owner = await signInViaMagicLink("own4@example.com");
    const { roomId } = await createPrivate(owner);
    // The owner types the login as they saw it; GitHub reports it lowercased.
    const { token } = await mintInvite(owner, roomId, { addressedGithubLogin: "Alice" });
    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice-agent", invite: token }),
    });
    expect(join.status).toBe(201);

    const alice = await signInViaGithub("alice", "alice-gh@example.com");
    expect(alice).not.toBe("");
    const hist = await SELF.fetch(`${BASE}/api/me/rooms?filter=joined`, {
      headers: { cookie: alice },
    });
    const body = (await hist.json()) as { rooms: { roomId: string }[] };
    expect(body.rooms.map((r) => r.roomId)).toContain(roomId);
  });

  it("private room page is gated and public rooms are unchanged", async () => {
    const owner = await signInViaMagicLink("own3@example.com");
    const { roomId } = await createPrivate(owner);

    const anon = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "application/json" },
    });
    expect(anon.status).toBe(403);
    expect(await errorCodeOf(anon)).toBe("invite_required");

    const asOwner = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "application/json", cookie: owner },
    });
    expect(asOwner.status).toBe(200);

    const flip = await SELF.fetch(`${BASE}/api/rooms/${roomId}/private`, {
      method: "PUT",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ private: false }),
    });
    expect(flip.status).toBe(204);
    const afterFlip = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "application/json" },
    });
    expect(afterFlip.status).toBe(200);
  });

  it("shows a private page to browsers and admits an invite as an observer", async () => {
    const owner = await signInViaMagicLink("own4@example.com");
    const { roomId } = await createPrivate(owner);

    const anonHtml = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/html" } });
    expect(anonHtml.status).toBe(403);
    expect(await anonHtml.text()).toContain("This room is private");

    const ownerHtml = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "text/html", cookie: owner },
    });
    expect(ownerHtml.status).toBe(200);
    expect(await ownerHtml.text()).toContain('id="transcript"');

    const { token } = await mintInvite(owner, roomId);
    const withInvite = await SELF.fetch(`${BASE}/r/${roomId}?invite=${token}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(withInvite.status).toBe(302);
    const location = withInvite.headers.get("location") ?? "";
    expect(location).toContain(`/r/${roomId}#observer=`);
    // The invite is single use: the observer join consumed it.
    const again = await SELF.fetch(`${BASE}/r/${roomId}?invite=${token}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(again.status).toBe(403);
  });

  it("serves the markdown instructions to an invited agent without consuming the invite", async () => {
    const owner = await signInViaMagicLink("own5@example.com");
    const { roomId } = await createPrivate(owner);
    const { token } = await mintInvite(owner, roomId);

    const denied = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "text/markdown" },
    });
    expect(denied.status).toBe(403);

    const md = await SELF.fetch(`${BASE}/r/${roomId}?invite=${token}`, {
      headers: { accept: "text/markdown" },
    });
    expect(md.status).toBe(200);
    expect(await md.text()).toContain("Private rooms");

    // Still usable afterwards: reading the instructions is not joining.
    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "reader", invite: token }),
    });
    expect(join.status).toBe(201);
  });

  it("keeps the room metadata and transcript behind the same gate", async () => {
    const owner = await signInViaMagicLink("own8@example.com");
    const { roomId } = await createPrivate(owner);
    const { token } = await mintInvite(owner, roomId);

    const anon = await SELF.fetch(`${BASE}/api/rooms/${roomId}`);
    expect(anon.status).toBe(403);
    expect(await errorCodeOf(anon)).toBe("invite_required");
    expect((await SELF.fetch(`${BASE}/api/rooms/${roomId}/transcript`)).status).toBe(403);

    const asOwner = await SELF.fetch(`${BASE}/api/rooms/${roomId}`, {
      headers: { cookie: owner },
    });
    expect(asOwner.status).toBe(200);

    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "member", invite: token }),
    });
    const member = (await join.json()) as { token: string };
    const asMember = await SELF.fetch(`${BASE}/api/rooms/${roomId}`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(asMember.status).toBe(200);
  });

  it("only the creator may flip a room private", async () => {
    const owner = await signInViaMagicLink("own6@example.com");
    const stranger = await signInViaMagicLink("stranger6@example.com");
    const { roomId } = await createPrivate(owner);
    const res = await SELF.fetch(`${BASE}/api/rooms/${roomId}/private`, {
      method: "PUT",
      headers: {
        cookie: stranger,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ private: false }),
    });
    expect(res.status).toBe(403);
  });

  it("a linked member of a private room may rejoin without an invite", async () => {
    const owner = await signInViaMagicLink("own7@example.com");
    const guest = await signInViaMagicLink("guest7@example.com");
    const { roomId } = await createPrivate(owner);
    const { token } = await mintInvite(owner, roomId);
    const first = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { cookie: guest, "content-type": "application/json" },
      body: JSON.stringify({ name: "guest-one", invite: token }),
    });
    expect(first.status).toBe(201);
    const second = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { cookie: guest, "content-type": "application/json" },
      body: JSON.stringify({ name: "guest-two" }),
    });
    expect(second.status).toBe(201);
  });
  it("lets a joined agent re-read the instructions with its member token", async () => {
    const owner = await signInViaMagicLink("own9@example.com");
    const { roomId } = await createPrivate(owner);
    const { token } = await mintInvite(owner, roomId);
    const join = await SELF.fetch(`${BASE}/api/rooms/${roomId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "reader2", invite: token }),
    });
    expect(join.status).toBe(201);
    const member = ((await join.json()) as { token: string }).token;

    // The invite is spent now, so the member token is all the agent still
    // holds. It must be enough to read the room it is already inside.
    const spent = await SELF.fetch(`${BASE}/r/${roomId}?invite=${token}`, {
      headers: { accept: "text/markdown" },
    });
    expect(spent.status).toBe(403);

    const md = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "text/markdown", authorization: `Bearer ${member}` },
    });
    expect(md.status).toBe(200);
    expect(await md.text()).toContain(roomId);

    const json = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "application/json", authorization: `Bearer ${member}` },
    });
    expect(json.status).toBe(200);
  });

  it("lets an observer who joined before a privacy flip still load the page", async () => {
    const owner = await signInViaMagicLink("own10@example.com");
    const create = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "cf-connecting-ip": `10.2.9.${Math.floor(Math.random() * 250)}`,
      },
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(201);
    const { roomId } = (await create.json()) as { roomId: string };
    const observerToken = await joinViaHttp(roomId, "watcher", "observer");

    const flip = await SELF.fetch(`${BASE}/api/rooms/${roomId}/private`, {
      method: "PUT",
      headers: {
        cookie: owner,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ private: true }),
    });
    expect(flip.status).toBe(204);

    const anon = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/html" } });
    expect(anon.status).toBe(403);

    const withToken = await SELF.fetch(`${BASE}/r/${roomId}`, {
      headers: { accept: "text/html", authorization: `Bearer ${observerToken}` },
    });
    expect(withToken.status).toBe(200);
    expect(await withToken.text()).toContain('id="transcript"');
  });
});
