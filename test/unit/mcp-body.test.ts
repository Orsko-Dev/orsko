import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "../../src/mcp/body";

function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(typeof s === "string" ? new TextEncoder().encode(s) : s);
      c.close();
    },
  });
}

function requestWith(body: BodyInit): Request {
  return new Request("https://orsko.dev/mcp", { method: "POST", body });
}

describe("readBoundedJson", () => {
  it("parses a JSON body within the cap", async () => {
    const result = await readBoundedJson(requestWith('{"a":1}'), 100);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("cuts off a stream that passes the cap", async () => {
    const request = requestWith(streamOf(["12345", "678901"]));
    const result = await readBoundedJson(request, 10);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(413);
    const body = (await result.response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Request body exceeds 10 bytes");
  });

  it("answers invalid JSON and invalid UTF-8 with a parse error", async () => {
    for (const body of ["{nope", new Uint8Array([0xff])]) {
      const result = await readBoundedJson(requestWith(body), 100);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.response.status).toBe(400);
      const parsed = (await result.response.json()) as { error: { code: number; message: string } };
      expect(parsed.error.code).toBe(-32700);
      expect(parsed.error.message).toBe("Parse error: Invalid JSON");
    }
  });

  it("answers a parse error, logging only the error class, when the stream errors mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
      },
      pull(controller) {
        controller.error(new Error("client disconnected mid-body"));
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await readBoundedJson(requestWith(stream), 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(400);
    const parsed = (await result.response.json()) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toBe("Parse error: Invalid JSON");
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("client disconnected");
    const logged = JSON.parse(line) as { level: string; event: string; errorClass: string };
    expect(logged).toMatchObject({
      level: "error",
      event: "mcp.body_read_failed",
      errorClass: "Error",
    });
    spy.mockRestore();
  });
});
