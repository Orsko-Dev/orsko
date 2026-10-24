import { describe, expect, it } from "vitest";
import { helloFrame, parseServerFrame, postFrame, readFrame } from "../src/frames.js";

const message = {
  id: "msg_1",
  seq: 4,
  roomId: "dvz35u66ge8v",
  from: "bob",
  text: "hello",
  attachmentIds: ["a_1"],
  createdAt: "2026-09-08T00:00:00.000Z",
};

describe("client frames", () => {
  it("builds a hello frame with the token and cursor", () => {
    expect(JSON.parse(helloFrame("tok_1", 12))).toEqual({
      type: "hello",
      token: "tok_1",
      since: 12,
    });
  });

  it("builds a post frame and omits attachmentIds when there are none", () => {
    expect(JSON.parse(postFrame("c1", "ship it"))).toEqual({
      type: "post",
      id: "c1",
      text: "ship it",
    });
    expect(JSON.parse(postFrame("c2", "ship it", ["a_1"]))).toEqual({
      type: "post",
      id: "c2",
      text: "ship it",
      attachmentIds: ["a_1"],
    });
  });

  it("builds a read frame", () => {
    expect(JSON.parse(readFrame(9))).toEqual({ type: "read", since: 9 });
  });
});

describe("parseServerFrame", () => {
  it("parses a welcome frame", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "welcome",
        roomId: "dvz35u66ge8v",
        you: { memberId: "m_1", name: "alice", role: "agent" },
        members: [{ memberId: "m_1", name: "alice", role: "agent", connected: true }],
        lastSeq: 4,
        state: "live",
      }),
    );
    expect(frame).toMatchObject({ type: "welcome", lastSeq: 4, state: "live" });
    expect(frame?.type === "welcome" && frame.members[0]?.connected).toBe(true);
  });

  it("parses a message frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "message", message }));
    expect(frame).toEqual({ type: "message", message });
  });

  it("defaults a message's attachmentIds to an empty list", () => {
    const { attachmentIds: _drop, ...bare } = message;
    const frame = parseServerFrame(JSON.stringify({ type: "message", message: bare }));
    expect(frame?.type === "message" && frame.message.attachmentIds).toEqual([]);
  });

  it("parses presence, state, ack and error frames", () => {
    expect(parseServerFrame(JSON.stringify({ type: "presence", members: [] }))).toEqual({
      type: "presence",
      members: [],
    });
    expect(parseServerFrame(JSON.stringify({ type: "state", state: "slow" }))).toEqual({
      type: "state",
      state: "slow",
    });
    expect(parseServerFrame(JSON.stringify({ type: "ack", id: "c1", seq: 4, message }))).toEqual({
      type: "ack",
      id: "c1",
      seq: 4,
      message,
    });
    expect(
      parseServerFrame(
        JSON.stringify({
          type: "error",
          id: "c1",
          code: "rate_limited",
          message: "slow down",
          retryAfterSeconds: 3,
        }),
      ),
    ).toEqual({
      type: "error",
      id: "c1",
      code: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 3,
    });
  });

  it("carries unread on an ack when the room sends it", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "ack", id: "c1", seq: 4, message, unread: 2 })),
    ).toEqual({ type: "ack", id: "c1", seq: 4, message, unread: 2 });
  });

  it("accepts an error frame without an id or retryAfterSeconds", () => {
    expect(parseServerFrame(JSON.stringify({ type: "error", code: "invalid_request" }))).toEqual({
      type: "error",
      code: "invalid_request",
      message: "invalid_request",
    });
  });

  it("returns null for anything that is not a known, well-formed frame", () => {
    const bad = [
      "not json",
      "[]",
      "null",
      JSON.stringify({ type: "nonsense" }),
      JSON.stringify({ type: "message" }),
      JSON.stringify({ type: "message", message: { ...message, seq: "4" } }),
      JSON.stringify({ type: "state", state: "melted" }),
      JSON.stringify({ type: "ack", id: "c1", seq: 4 }),
      JSON.stringify({ type: "presence", members: {} }),
      JSON.stringify({ type: "welcome", roomId: "r", lastSeq: 1, state: "live" }),
    ];
    for (const raw of bad) expect(parseServerFrame(raw)).toBeNull();
  });

  it("reads a frame delivered as bytes", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "state", state: "archived" }));
    expect(parseServerFrame(bytes)).toEqual({ type: "state", state: "archived" });
  });
});
