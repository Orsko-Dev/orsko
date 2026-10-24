import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EMPTY_BODY_MESSAGE,
  NOT_UTF8_MESSAGE,
  notJsonMessage,
  parseJsonBody,
  readJsonBody,
} from "../../src/http/body";

type Outcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

async function read(body: BodyInit | null, allowEmpty = false): Promise<Outcome> {
  const app = new Hono();
  app.post("/", async (c) => c.json(await readJsonBody(c, { allowEmpty })));
  const res = await app.request("/", { method: "POST", body });
  return (await res.json()) as Outcome;
}

const TextBody = z.object({ text: z.string().min(1) });

async function parse(body: string): Promise<Outcome> {
  const app = new Hono();
  app.post("/", async (c) => c.json(await parseJsonBody(c, TextBody)));
  const res = await app.request("/", { method: "POST", body });
  return (await res.json()) as Outcome;
}

describe("readJsonBody", () => {
  it("returns the parsed value of a JSON body", async () => {
    expect(await read('{"text":"hi"}')).toEqual({ ok: true, value: { text: "hi" } });
  });

  it("refuses an empty or blank body", async () => {
    const expected = { ok: false, code: "invalid_request", message: EMPTY_BODY_MESSAGE };
    expect(await read(null)).toEqual(expected);
    expect(await read("  \n")).toEqual(expected);
    expect(EMPTY_BODY_MESSAGE).toBe("request body is empty; send a JSON object");
  });

  it("reads an empty body as {} when the route allows it", async () => {
    expect(await read(null, true)).toEqual({ ok: true, value: {} });
  });

  it("names the parser error and the shell-quoting fix for a body that is not JSON", async () => {
    const result = await read("{'text':'it's'}");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_request");
    expect(result.message.startsWith("request body is not valid JSON (")).toBe(true);
    expect(result.message).toContain(
      "). If you built it in a shell, an apostrophe inside single quotes ends the string early: write the JSON to a file and send it with --data-binary @file",
    );
    expect(notJsonMessage("x")).toBe(
      "request body is not valid JSON (x). If you built it in a shell, an apostrophe inside single quotes ends the string early: write the JSON to a file and send it with --data-binary @file",
    );
  });

  it("refuses bytes that are not UTF-8 instead of storing replacement characters", async () => {
    // {"text":"<0xff>"}: valid JSON punctuation around one invalid UTF-8 byte.
    const bytes = new Uint8Array([
      0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
    ]);
    expect(await read(bytes)).toEqual({
      ok: false,
      code: "invalid_request",
      message: NOT_UTF8_MESSAGE,
    });
    expect(NOT_UTF8_MESSAGE).toBe(
      "request body is not valid UTF-8; send text encoded as UTF-8 (in PowerShell set $OutputEncoding = [System.Text.UTF8Encoding]::new())",
    );
  });

  it("keeps multi-byte UTF-8 text intact", async () => {
    expect(await read(JSON.stringify({ text: "a – b ✓" }))).toEqual({
      ok: true,
      value: { text: "a – b ✓" },
    });
  });
});

describe("parseJsonBody", () => {
  it("prefixes a schema failure with the field path", async () => {
    expect(await parse('{"text":""}')).toEqual({
      ok: false,
      code: "invalid_request",
      message: "text: Too small: expected string to have >=1 characters",
    });
  });

  it("keeps a top-level schema failure unprefixed", async () => {
    expect(await parse("null")).toEqual({
      ok: false,
      code: "invalid_request",
      message: "Invalid input: expected object, received null",
    });
  });

  it("returns the parsed data on success", async () => {
    expect(await parse('{"text":"ok"}')).toEqual({ ok: true, value: { text: "ok" } });
  });
});
