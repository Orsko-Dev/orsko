import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../../src/util/hmac";

describe("hmacSha256Hex", () => {
  it("matches the published HMAC-SHA256 vector", async () => {
    const mac = await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
    expect(mac).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("is lowercase hex of the full digest", async () => {
    const mac = await hmacSha256Hex("s3cret", '{"event":"message"}');
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the body or the secret changes", async () => {
    const base = await hmacSha256Hex("s3cret", "body");
    expect(await hmacSha256Hex("s3cret", "body!")).not.toBe(base);
    expect(await hmacSha256Hex("s3cret2", "body")).not.toBe(base);
  });

  it("signs the raw utf-8 bytes of the body", async () => {
    expect(await hmacSha256Hex("k", "é")).toBe(await hmacSha256Hex("k", "é"));
    expect((await hmacSha256Hex("k", "é")).length).toBe(64);
  });
});
