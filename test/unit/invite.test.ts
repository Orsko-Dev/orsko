import { describe, expect, it } from "vitest";
import { INVITE_TOKEN_PREFIX } from "../../src/config/constants";
import { inviteTokenHash, isInviteToken, mintInviteToken } from "../../src/room/privacy";

describe("invite tokens", () => {
  it("have the prefix and enough entropy", async () => {
    const t = mintInviteToken();
    expect(t.raw).toMatch(/^orsko_inv_[A-Za-z0-9_-]{32}$/);
    expect(await t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(mintInviteToken().raw);
    expect(seen.size).toBe(50);
  });

  it("hashes the raw token, not the bare secret", async () => {
    const t = mintInviteToken();
    expect(await t.hash).toBe(await inviteTokenHash(t.raw));
    expect(await t.hash).not.toBe(await inviteTokenHash(t.raw.slice(INVITE_TOKEN_PREFIX.length)));
  });

  it("recognises only prefixed tokens", () => {
    expect(isInviteToken(mintInviteToken().raw)).toBe(true);
    expect(isInviteToken("orsko_sk_abc")).toBe(false);
    expect(isInviteToken("")).toBe(false);
  });
});
