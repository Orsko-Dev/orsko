import { describe, expect, it } from "vitest";
import { keyHash, mintKey } from "../../src/account/keys";

describe("api keys", () => {
  it("mints keys with the prefix and a stable display prefix", async () => {
    const { raw, prefix } = mintKey();
    expect(raw).toMatch(/^orsko_sk_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(raw.slice(0, 12));
    expect(await keyHash(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});
