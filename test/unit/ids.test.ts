import { describe, expect, it } from "vitest";
import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH } from "../../src/config/constants";
import {
  generateAttachmentId,
  generateMemberId,
  generateMessageId,
  generateRoomId,
  generateToken,
  hashToken,
  timingSafeEqual,
} from "../../src/util/ids";

describe("ids", () => {
  it("room ids use the alphabet and length", () => {
    const id = generateRoomId();
    expect(id).toHaveLength(ROOM_ID_LENGTH);
    for (const ch of id) expect(ROOM_ID_ALPHABET).toContain(ch);
  });

  it("room ids are unique across many draws", () => {
    const ids = new Set(Array.from({ length: 1000 }, generateRoomId));
    expect(ids.size).toBe(1000);
  });

  it("prefixed ids carry their prefix", () => {
    expect(generateMemberId()).toMatch(/^u_[a-z0-9]{16}$/);
    expect(generateAttachmentId()).toMatch(/^a_[a-z0-9]{16}$/);
    expect(generateMessageId()).toMatch(/^m_[a-z0-9]{16}$/);
  });

  it("tokens are base64url of 32 bytes", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashToken is deterministic hex sha256", async () => {
    const a = await hashToken("abc");
    expect(a).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashToken("abc")).toBe(a);
  });

  it("timingSafeEqual compares correctly", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});
