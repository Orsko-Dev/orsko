import { describe, expect, it } from "vitest";
import {
  AttachmentIdParam,
  CreateRoomBody,
  JoinBody,
  PollQuery,
  PostMessageBody,
  RoomIdParam,
  UploadHeaders,
} from "../../src/validation/schemas";

describe("schemas", () => {
  it("CreateRoomBody accepts empty and purpose", () => {
    expect(CreateRoomBody.parse({})).toEqual({});
    expect(CreateRoomBody.parse({ purpose: "fix bug" })).toEqual({ purpose: "fix bug" });
    expect(CreateRoomBody.safeParse({ purpose: "x".repeat(501) }).success).toBe(false);
  });

  it("JoinBody validates names and defaults role", () => {
    expect(JoinBody.parse({ name: "alice" })).toEqual({ name: "alice", role: "agent" });
    expect(JoinBody.parse({ name: "bob-2", role: "observer" }).role).toBe("observer");
    expect(JoinBody.safeParse({ name: "" }).success).toBe(false);
    expect(JoinBody.safeParse({ name: "has space" }).success).toBe(false);
    expect(JoinBody.safeParse({ name: "system" }).success).toBe(false);
    expect(JoinBody.safeParse({ name: "a".repeat(33) }).success).toBe(false);
  });

  it("PostMessageBody requires text and caps attachment ids", () => {
    expect(PostMessageBody.parse({ text: "hi" })).toEqual({ text: "hi", attachmentIds: [] });
    expect(PostMessageBody.safeParse({ text: "" }).success).toBe(false);
    const ids = Array.from({ length: 11 }, (_, i) => `a_${String(i).padStart(16, "0")}`);
    expect(PostMessageBody.safeParse({ text: "x", attachmentIds: ids }).success).toBe(false);
    expect(PostMessageBody.safeParse({ text: "x", attachmentIds: ["bad"] }).success).toBe(false);
  });

  it("PollQuery coerces and caps wait", () => {
    expect(PollQuery.parse({})).toEqual({ since: 0, waitSeconds: 25 });
    expect(PollQuery.parse({ since: "7", waitSeconds: "5" })).toEqual({ since: 7, waitSeconds: 5 });
    expect(PollQuery.parse({ waitSeconds: "99" }).waitSeconds).toBe(25);
    expect(PollQuery.safeParse({ since: "-1" }).success).toBe(false);
  });

  it("UploadHeaders requires filename and content-length", () => {
    expect(
      UploadHeaders.parse({
        "x-filename": "a.txt",
        "content-length": "12",
        "content-type": "text/plain",
      }),
    ).toEqual({ filename: "a.txt", size: 12, contentType: "text/plain" });
    expect(UploadHeaders.safeParse({ "content-length": "12" }).success).toBe(false);
    expect(UploadHeaders.safeParse({ "x-filename": "../x", "content-length": "1" }).success).toBe(
      false,
    );
    expect(UploadHeaders.parse({ "x-filename": "a", "content-length": "1" }).contentType).toBe(
      "application/octet-stream",
    );
  });

  it("UploadHeaders rejects control characters in the filename", () => {
    for (const name of ["a\tb.txt", "a\u0000b.txt", "a\u001bb.txt", "a\u007fb.txt"]) {
      expect(UploadHeaders.safeParse({ "x-filename": name, "content-length": "1" }).success).toBe(
        false,
      );
    }
    expect(
      UploadHeaders.safeParse({ "x-filename": "résumé.txt", "content-length": "1" }).success,
    ).toBe(true);
  });

  it("id params match generated formats", () => {
    expect(RoomIdParam.safeParse("abcdefghjkmn").success).toBe(true);
    expect(RoomIdParam.safeParse("ABCDEFGHJKMN").success).toBe(false);
    expect(AttachmentIdParam.safeParse("a_abcdefghij012345").success).toBe(true);
    expect(AttachmentIdParam.safeParse("m_abcdefghij012345").success).toBe(false);
  });
});
