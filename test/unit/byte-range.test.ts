import { describe, expect, it } from "vitest";
import { parseByteRange } from "../../src/http/byte-range";

const SIZE = 1000;

describe("parseByteRange", () => {
  it("serves the whole file when no Range was asked for", () => {
    expect(parseByteRange(null, SIZE)).toEqual({ kind: "full" });
    expect(parseByteRange("", SIZE)).toEqual({ kind: "full" });
  });

  it("reads a closed range, inclusive of both ends", () => {
    expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(parseByteRange("bytes=0-1", SIZE)).toEqual({ kind: "partial", start: 0, end: 1 });
  });

  it("clamps an end past the file to the last byte", () => {
    expect(parseByteRange("bytes=900-5000", SIZE)).toEqual({
      kind: "partial",
      start: 900,
      end: 999,
    });
  });

  it("reads an open range to the end of the file", () => {
    expect(parseByteRange("bytes=500-", SIZE)).toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("reads a suffix range as the last N bytes, capped at the file", () => {
    expect(parseByteRange("bytes=-100", SIZE)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("tolerates whitespace and a differently cased unit", () => {
    expect(parseByteRange(" Bytes = 10 - 19 ", SIZE)).toEqual({
      kind: "partial",
      start: 10,
      end: 19,
    });
  });

  it("is unsatisfiable when the range starts past the file or asks for zero suffix bytes", () => {
    expect(parseByteRange("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=2000-2100", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  // RFC 9110 §14.2: a server may ignore a Range it cannot or will not honour
  // and answer 200 with the whole representation.
  it("ignores malformed, reversed, multi-part and non-byte ranges", () => {
    for (const header of [
      "bytes=abc",
      "bytes=99-10",
      "bytes=-",
      "bytes=0-1,5-9",
      "items=0-1",
      "bytes=1.5-2",
      "bytes=0x10-20",
    ]) {
      expect(parseByteRange(header, SIZE), header).toEqual({ kind: "full" });
    }
  });
});
