import { describe, expect, it } from "vitest";
import {
  acknowledge,
  EMPTY_PENDING,
  prependResend,
  remember,
  resendLines,
} from "../src/pending.js";

const one = { seq: 4, from: "bob", content: "does the deploy look right?", at: 1_000 };
const two = { seq: 5, from: "carol", content: "shipping now", at: 90_000 };

describe("pending resend bookkeeping", () => {
  it("remembers entries without mutating the previous state", () => {
    const first = remember(EMPTY_PENDING, [one]);
    const second = remember(first, [two]);
    expect(EMPTY_PENDING.entries).toHaveLength(0);
    expect(first.entries).toHaveLength(1);
    expect(second.entries.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("acknowledging clears everything", () => {
    expect(acknowledge(remember(EMPTY_PENDING, [one, two])).entries).toHaveLength(0);
  });

  it("resends only entries older than the threshold", () => {
    const state = remember(EMPTY_PENDING, [one, two]);
    expect(resendLines(state, 30_000, 60_000)).toEqual([]);
    const lines = resendLines(state, 70_000, 60_000);
    expect(lines).toEqual([
      "[resent, not yet acknowledged] bob (seq 4): does the deploy look right?",
    ]);
    expect(resendLines(state, 200_000, 60_000)).toHaveLength(2);
  });

  it("prepends resend lines above the new content", () => {
    expect(prependResend("hello", ["[resent, not yet acknowledged] bob (seq 4): hi"])).toBe(
      "[resent, not yet acknowledged] bob (seq 4): hi\nhello",
    );
    expect(prependResend("hello", [])).toBe("hello");
  });

  it("truncates a long resent line so a resend cannot blow up the context", () => {
    const long = remember(EMPTY_PENDING, [{ ...one, content: "x".repeat(500) }]);
    const line = resendLines(long, 70_000, 60_000)[0] ?? "";
    expect(line.length).toBeLessThan(300);
    expect(line.endsWith("…")).toBe(true);
  });
});
