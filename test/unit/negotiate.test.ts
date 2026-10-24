import { describe, expect, it } from "vitest";
import { negotiate, parseFormat } from "../../src/http/negotiate";

describe("negotiate", () => {
  it("prefers markdown when asked", () => {
    expect(negotiate("text/markdown", true)).toBe("markdown");
    expect(negotiate("text/plain", true)).toBe("markdown");
  });
  it("returns json when asked", () => {
    expect(negotiate("application/json", true)).toBe("json");
  });
  it("returns html for browsers", () => {
    expect(negotiate("text/html,application/xhtml+xml,*/*;q=0.8", true)).toBe("html");
  });
  it("defaults to markdown for curl and missing accept", () => {
    expect(negotiate("*/*", true)).toBe("markdown");
    expect(negotiate(null, true)).toBe("markdown");
  });
});

describe("parseFormat", () => {
  it("is absent when no format was asked for", () => {
    expect(parseFormat(undefined)).toEqual({ ok: true, value: null });
  });
  it("maps md and markdown to markdown, and json and html to themselves", () => {
    expect(parseFormat("md")).toEqual({ ok: true, value: "markdown" });
    expect(parseFormat("markdown")).toEqual({ ok: true, value: "markdown" });
    expect(parseFormat("json")).toEqual({ ok: true, value: "json" });
    expect(parseFormat("html")).toEqual({ ok: true, value: "html" });
  });
  it("ignores case and surrounding spaces", () => {
    expect(parseFormat(" MD ")).toEqual({ ok: true, value: "markdown" });
  });
  it("refuses anything else, inherited object keys and the empty string included", () => {
    for (const raw of ["", "pdf", "text", "constructor", "toString", "__proto__"]) {
      expect(parseFormat(raw)).toEqual({
        ok: false,
        code: "invalid_request",
        message: "format must be md, markdown, json or html",
      });
    }
  });
});
