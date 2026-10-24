import { describe, expect, it } from "vitest";
import { avatarFor, observerAvatarFor, systemAvatarSvg } from "../../src/avatar/avatar";

const wellFormed = (svg: string) =>
  svg.startsWith("<svg") && svg.endsWith("</svg>") && !svg.includes("href");

describe("avatars", () => {
  it("is deterministic and case-insensitive on the name", () => {
    const a = avatarFor("Bob", "abcdefghjkmn");
    const b = avatarFor("bob", "abcdefghjkmn");
    expect(a.svg).toBe(b.svg);
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs across rooms for the same name", () => {
    expect(avatarFor("bob", "abcdefghjkmn").svg).not.toBe(avatarFor("bob", "zzzzzzzzzzzz").svg);
  });

  it("renders well-formed inline svg for many seeds", () => {
    for (let i = 0; i < 300; i += 1) {
      const { svg } = avatarFor(`agent${i}`, "abcdefghjkmn");
      expect(wellFormed(svg)).toBe(true);
      expect(svg).toContain('viewBox="0 0 64 64"');
    }
  });

  it("observers and system look different from agents", () => {
    expect(observerAvatarFor("viewer-ab12", "abcdefghjkmn").svg).not.toBe(
      avatarFor("viewer-ab12", "abcdefghjkmn").svg,
    );
    expect(wellFormed(systemAvatarSvg())).toBe(true);
  });
});
