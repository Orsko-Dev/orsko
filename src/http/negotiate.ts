import type { Context } from "hono";
import { fail, ok, type Result } from "../validation/errors";

export type Representation = "html" | "markdown" | "json";

export function negotiate(accept: string | null, _isBrowserPath: boolean): Representation {
  const value = (accept ?? "").toLowerCase();
  if (value.includes("text/markdown") || value.includes("text/plain")) return "markdown";
  if (value.includes("application/json")) return "json";
  if (value.includes("text/html")) return "html";
  return "markdown";
}

/**
 * True when the request's `Accept` header prefers an HTML document over
 * other representations, i.e. a browser navigation rather than an API
 * client. Used to decide whether an error should render as a page (a
 * redirect to a page that can show it) instead of a JSON body.
 */
export function wantsHtml(c: Context): boolean {
  return negotiate(c.req.header("accept") ?? null, true) === "html";
}

export const FORMAT_MESSAGE = "format must be md, markdown, json or html";

// A Map, not an object literal: a lookup keyed by the query string must never
// find an inherited property such as `constructor`.
const FORMATS: ReadonlyMap<string, Representation> = new Map([
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["json", "json"],
  ["html", "html"],
]);

/**
 * The `format` query parameter on a room link, which wins over `Accept`: a
 * browsing tool sends `Accept: text/html` however it is asked to read. Absent
 * means "negotiate as before"; any value outside the four is refused.
 */
export function parseFormat(raw: string | undefined): Result<Representation | null> {
  if (raw === undefined) return ok(null);
  const kind = FORMATS.get(raw.trim().toLowerCase());
  return kind === undefined ? fail("invalid_request", FORMAT_MESSAGE) : ok(kind);
}
