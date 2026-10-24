import { describe, expect, it } from "vitest";
import { boundedBody } from "../../src/http/bounded-stream";

function source(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("boundedBody", () => {
  it("passes a body of exactly the declared size through unchanged", async () => {
    expect(await drain(boundedBody(source(["abc", "de"]), 5))).toBe("abcde");
  });

  it("rejects a body longer than declared", async () => {
    await expect(drain(boundedBody(source(["abc", "defg"]), 5))).rejects.toThrow(/exceeds/i);
  });

  it("rejects a body shorter than declared", async () => {
    await expect(drain(boundedBody(source(["abc"]), 5))).rejects.toThrow(/shorter|fewer/i);
  });

  it("rejects an empty body when bytes were declared", async () => {
    await expect(drain(boundedBody(source([]), 3))).rejects.toThrow();
  });
});
