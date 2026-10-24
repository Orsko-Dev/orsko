/**
 * How to answer a request for a file of `size` bytes, given its `Range` header.
 *
 * - `full`: no usable range — answer 200 with the whole file.
 * - `partial`: answer 206 with bytes `start` through `end`, inclusive.
 * - `unsatisfiable`: the range lies wholly outside the file — answer 416.
 */
export type ByteRange =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const FULL: ByteRange = { kind: "full" };
const UNSATISFIABLE: ByteRange = { kind: "unsatisfiable" };

/** A single `bytes=` range: `first-last`, `first-`, or the suffix form `-length`. */
const SINGLE_BYTE_RANGE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i;

/**
 * Parses a `Range` header for one byte range (RFC 9110 §14.1.2).
 *
 * Only a single range is honoured. Anything else — a malformed or reversed
 * range, several ranges, or a unit other than bytes — is ignored and the whole
 * file is served, which RFC 9110 §14.2 permits. Media players only ever ask for
 * one range at a time.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  const match = SINGLE_BYTE_RANGE.exec((header ?? "").trim());
  if (!match) return FULL;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return FULL;

  if (first === "") {
    const suffixLength = Number(last);
    if (suffixLength === 0 || size === 0) return UNSATISFIABLE;
    return { kind: "partial", start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(first);
  if (last !== "" && Number(last) < start) return FULL;
  if (start >= size) return UNSATISFIABLE;
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { kind: "partial", start, end };
}
