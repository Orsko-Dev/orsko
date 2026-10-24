import { describe, expect, it } from "vitest";
import { getTier, TIERS } from "../../src/config/tiers";

describe("tiers", () => {
  it("free tier has the spec limits", () => {
    expect(TIERS.free).toEqual({
      liveWindowSecondsPerDay: 21600,
      idleToSlowSeconds: 1800,
      idleToArchiveSeconds: 86400,
      archiveRetentionDays: 7,
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
      maxAttachmentBytes: 10 * 1024 * 1024,
      maxAttachmentsPerRoom: 50,
      maxMembers: 8,
      maxPostsPerMinutePerMember: 60,
    });
  });

  it("paid tier has unlimited live window and larger caps", () => {
    expect(TIERS.paid.liveWindowSecondsPerDay).toBeNull();
    expect(TIERS.paid.maxAttachmentBytes).toBe(100 * 1024 * 1024);
    expect(TIERS.paid.archiveRetentionDays).toBe(90);
    expect(TIERS.paid.maxMembers).toBe(50);
  });

  it("getTier throws on unknown tier", () => {
    expect(() => getTier("gold")).toThrow(/unknown tier/i);
  });
});
