import { beforeEach, describe, expect, it, vi } from "vitest";
import { guarded, toolError, toolJson } from "../../src/mcp/results";

describe("guarded", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("turns an exception into a tool error and logs only the tool and error class", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await guarded("orsko_members", async () => {
      throw new TypeError("boom orsko_sk_secret");
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Orsko could not complete that request" }],
      isError: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("boom");
    const parsed = JSON.parse(line) as {
      level: string;
      event: string;
      tool: string;
      errorClass: string;
    };
    expect(parsed).toMatchObject({
      level: "error",
      event: "mcp.tool_failed",
      tool: "orsko_members",
      errorClass: "TypeError",
    });
  });
});

describe("toolError", () => {
  it("carries a room error as the API's error body", () => {
    const result = toolError("invalid_token", "token is not valid");
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
      error: { code: string; message: string };
    };
    expect(parsed).toEqual({ error: { code: "invalid_token", message: "token is not valid" } });
  });
});

describe("toolJson", () => {
  it("adds a note only when there is one", () => {
    const withoutNote = toolJson({ a: 1 });
    expect(withoutNote.content).toHaveLength(1);
    expect(withoutNote.structuredContent).toEqual({ a: 1 });

    const withNote = toolJson({ a: 1 }, "note");
    expect(withNote.content).toHaveLength(2);
    expect(withNote.content[1]).toEqual({ type: "text", text: "note" });
  });
});
