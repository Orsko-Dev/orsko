import { describe, expect, it } from "vitest";
import { parseClientFrame } from "../../src/validation/frames";

describe("parseClientFrame", () => {
  it("accepts a hello frame with and without a cursor", () => {
    expect(parseClientFrame('{"type":"hello","token":"t"}')).toEqual({
      kind: "frame",
      frame: { type: "hello", token: "t" },
    });
    const withCursor = parseClientFrame('{"type":"hello","token":"t","since":7}');
    expect(withCursor).toMatchObject({ kind: "frame", frame: { since: 7 } });
  });

  it("defaults post attachmentIds to an empty list", () => {
    const parsed = parseClientFrame('{"type":"post","id":"c1","text":"hi"}');
    expect(parsed).toMatchObject({ kind: "frame", frame: { attachmentIds: [] } });
  });

  it("accepts a read frame", () => {
    expect(parseClientFrame('{"type":"read","since":3}')).toMatchObject({
      kind: "frame",
      frame: { type: "read", since: 3 },
    });
  });

  it("reports non-JSON as malformed", () => {
    expect(parseClientFrame("nope").kind).toBe("malformed");
  });

  it("reports an unknown type as invalid", () => {
    expect(parseClientFrame('{"type":"shout"}').kind).toBe("invalid");
  });

  it("keeps the client id on an invalid frame so it can be correlated", () => {
    expect(parseClientFrame('{"type":"post","id":"c2"}')).toMatchObject({
      kind: "invalid",
      id: "c2",
    });
  });

  it("drops an id that is not a usable string", () => {
    expect(parseClientFrame('{"type":"post","id":42,"text":"hi"}')).toMatchObject({
      kind: "invalid",
      id: undefined,
    });
  });

  it("rejects an empty token, a blank post and a negative cursor", () => {
    expect(parseClientFrame('{"type":"hello","token":""}').kind).toBe("invalid");
    expect(parseClientFrame('{"type":"post","id":"c","text":""}').kind).toBe("invalid");
    expect(parseClientFrame('{"type":"read","since":-1}').kind).toBe("invalid");
  });

  it("rejects a bad attachment id", () => {
    expect(
      parseClientFrame('{"type":"post","id":"c","text":"hi","attachmentIds":["nope"]}').kind,
    ).toBe("invalid");
  });

  it("reports a JSON array as invalid rather than malformed", () => {
    expect(parseClientFrame("[1,2,3]").kind).toBe("invalid");
  });
});
