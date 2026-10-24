import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  parseCookies,
  sessionCookie,
  signState,
  verifyState,
} from "../../src/account/session";

describe("session helpers", () => {
  it("parses cookies", () => {
    expect(parseCookies("a=1; orsko_session=abc%20d; b=2")).toEqual({
      a: "1",
      orsko_session: "abc d",
      b: "2",
    });
    expect(parseCookies(null)).toEqual({});
  });

  it("falls back to the raw value when a cookie is not valid percent-encoding", () => {
    expect(parseCookies("a=%; orsko_session=x")).toEqual({ a: "%", orsko_session: "x" });
  });

  it("builds a hardened cookie", () => {
    const c = sessionCookie("xyz", 2592000);
    expect(c).toContain("orsko_session=xyz");
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=2592000"])
      expect(c).toContain(flag);
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("signs and verifies oauth state", async () => {
    const signed = await signState("secret", "nonce123");
    expect(await verifyState("secret", signed)).toBe("nonce123");
    expect(await verifyState("other", signed)).toBeNull();
    expect(await verifyState("secret", `${signed}x`)).toBeNull();
    expect(await verifyState("secret", "nodot")).toBeNull();
  });

  it("rejects an oauth state older than its ten-minute window", async () => {
    const issued = Date.now();
    const signed = await signState("secret", "nonce123", issued);
    // The timestamp is signed with the nonce, so it is the mac's own payload.
    expect(signed.split(".")).toHaveLength(3);
    expect(await verifyState("secret", signed, issued + 9 * 60_000)).toBe("nonce123");
    expect(await verifyState("secret", signed, issued + 11 * 60_000)).toBeNull();
  });

  it("rejects a state that was re-dated to buy itself more time", async () => {
    const issued = Date.now() - 11 * 60_000;
    const signed = await signState("secret", "nonce123", issued);
    const [nonce, , mac] = signed.split(".");
    // The date is inside the signed payload, so moving it breaks the mac.
    expect(await verifyState("secret", `${nonce}.${Date.now()}.${mac}`)).toBeNull();
  });
});
