import { describe, expect, it } from "vitest";
import { isValidSenderShape } from "../../src/account/email";

describe("isValidSenderShape", () => {
  it("accepts a display-name sender", () => {
    expect(isValidSenderShape("Orsko <signin@notifications.orsko.dev>")).toBe(true);
  });

  it("accepts a bare address", () => {
    expect(isValidSenderShape("signin@notifications.orsko.dev")).toBe(true);
  });

  it("rejects a malformed string", () => {
    expect(isValidSenderShape("not a valid sender")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidSenderShape("")).toBe(false);
  });

  it("rejects a display-name sender missing the angle-bracketed address", () => {
    expect(isValidSenderShape("Orsko signin@notifications.orsko.dev")).toBe(false);
  });

  it("rejects an address with no domain", () => {
    expect(isValidSenderShape("signin@localhost")).toBe(false);
  });
});
