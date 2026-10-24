import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as adb from "../../src/account/db";
import { createSession, resolveSession } from "../../src/account/session";
import { SESSION_TTL_MS } from "../../src/config/constants";
import { hashToken } from "../../src/util/ids";

const now = Date.UTC(2026, 8, 8);

describe("account db", () => {
  it("upserts a user by email and merges github fields", async () => {
    const a = await adb.upsertUserByEmail(env.DB, {
      email: "Alice@Example.com",
      displayName: "Alice",
    });
    const b = await adb.upsertUserByEmail(env.DB, {
      email: "alice@example.com",
      githubId: "99",
      githubLogin: "alice",
    });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe("alice@example.com");
    expect(b.github_login).toBe("alice");
    expect(b.display_name).toBe("Alice");
    expect(await adb.findUserByGithubId(env.DB, "99")).toMatchObject({ id: a.id });
  });

  it("sessions expire and can be touched and deleted", async () => {
    const u = await adb.upsertUserByEmail(env.DB, { email: "s@example.com" });
    await adb.insertSession(env.DB, { idHash: "h1", userId: u.id, userAgent: "ua", now });
    const s = await adb.findSession(env.DB, "h1", now + 1000);
    expect(s?.user_id).toBe(u.id);
    expect(await adb.findSession(env.DB, "h1", now + 31 * 86400_000)).toBeNull();
    await adb.touchSession(env.DB, "h1", now + 60 * 86400_000);
    expect(await adb.findSession(env.DB, "h1", now + 31 * 86400_000)).not.toBeNull();
    await adb.deleteSession(env.DB, "h1");
    expect(await adb.findSession(env.DB, "h1", now)).toBeNull();
  });

  it("magic links are single use and expire", async () => {
    await adb.insertMagicLink(env.DB, { tokenHash: "m1", email: "m@example.com", now });
    expect(await adb.consumeMagicLink(env.DB, "m1", now + 1000)).toBe("m@example.com");
    expect(await adb.consumeMagicLink(env.DB, "m1", now + 2000)).toBeNull();
    await adb.insertMagicLink(env.DB, { tokenHash: "m2", email: "m@example.com", now });
    expect(await adb.consumeMagicLink(env.DB, "m2", now + 16 * 60_000)).toBeNull();
  });

  it("api keys list, resolve, and revoke", async () => {
    const u = await adb.upsertUserByEmail(env.DB, { email: "k@example.com" });
    await adb.insertApiKey(env.DB, {
      id: "k1",
      userId: u.id,
      keyHash: "kh1",
      prefix: "orsko_sk_abc",
      label: "laptop",
      now,
    });
    expect(await adb.countActiveApiKeys(env.DB, u.id)).toBe(1);
    expect(await adb.findApiKeyByHash(env.DB, "kh1")).toMatchObject({ id: "k1", user_id: u.id });
    expect(await adb.revokeApiKey(env.DB, u.id, "k1", now)).toBe(true);
    expect(await adb.findApiKeyByHash(env.DB, "kh1")).toBeNull();
    expect(await adb.revokeApiKey(env.DB, u.id, "k1", now)).toBe(false);
  });
});

describe("session lifetime", () => {
  const start = Date.UTC(2026, 8, 8, 12);

  it("stops resolving once the thirty days are up", async () => {
    const u = await adb.upsertUserByEmail(env.DB, { email: "expiry@example.com" });
    const raw = await createSession(env.DB, u.id, "ua", start);
    expect(await resolveSession(env.DB, raw, start + 1_000)).toEqual({ userId: u.id });
    expect(await resolveSession(env.DB, raw, start + SESSION_TTL_MS + 1)).toBeNull();
    // Nothing revives it afterwards: the row is simply past its expiry.
    expect(await resolveSession(env.DB, raw, start + SESSION_TTL_MS + 86_400_000)).toBeNull();
  });

  it("slides the expiry forward on use, but only once an hour", async () => {
    const u = await adb.upsertUserByEmail(env.DB, { email: "touch@example.com" });
    const raw = await createSession(env.DB, u.id, "ua", start);
    const idHash = await hashToken(raw);
    const expiresAt = async (): Promise<number | undefined> =>
      (await adb.findSession(env.DB, idHash, start))?.expires_at;
    expect(await expiresAt()).toBe(start + SESSION_TTL_MS);

    // Inside the touch interval: the row is left alone.
    await resolveSession(env.DB, raw, start + 60_000);
    expect(await expiresAt()).toBe(start + SESSION_TTL_MS);

    // Two hours in, the expiry moves out to thirty days from now.
    const later = start + 2 * 3_600_000;
    expect(await resolveSession(env.DB, raw, later)).toEqual({ userId: u.id });
    expect(await expiresAt()).toBe(later + SESSION_TTL_MS);
  });
});
