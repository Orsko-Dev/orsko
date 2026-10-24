import type { Context } from "hono";
import type { ZodError, ZodType } from "zod";
import { fail, ok, type Result } from "../validation/errors";

/**
 * The one reader for JSON request bodies. It decodes strictly, so bytes that
 * are not UTF-8 are refused instead of being stored as U+FFFD. Every failure
 * says what to do next, because the caller is usually an agent building the
 * request in a shell.
 */

/** How a route treats a request that carries no body at all. */
export interface ReadJsonOptions {
  /** An empty body reads as `{}`: only for routes whose every field is optional. */
  readonly allowEmpty?: boolean;
}

export const EMPTY_BODY_MESSAGE = "request body is empty; send a JSON object";

export const NOT_UTF8_MESSAGE =
  "request body is not valid UTF-8; send text encoded as UTF-8 (in PowerShell set $OutputEncoding = [System.Text.UTF8Encoding]::new())";

const SHELL_QUOTING_HINT =
  "If you built it in a shell, an apostrophe inside single quotes ends the string early: write the JSON to a file and send it with --data-binary @file";

export function notJsonMessage(parserMessage: string): string {
  return `request body is not valid JSON (${parserMessage}). ${SHELL_QUOTING_HINT}`;
}

function decodeUtf8(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readJsonBody(
  c: Context,
  options: ReadJsonOptions = {},
): Promise<Result<unknown>> {
  const text = decodeUtf8(await c.req.arrayBuffer());
  if (text === null) return fail("invalid_request", NOT_UTF8_MESSAGE);
  if (text.trim().length === 0) {
    return options.allowEmpty === true ? ok({}) : fail("invalid_request", EMPTY_BODY_MESSAGE);
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unparseable input";
    return fail("invalid_request", notJsonMessage(detail));
  }
}

/** The first Zod issue, prefixed with its field path when it has one. */
export function issueMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid body";
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/** Reads the body and validates it against `schema`, in one Result. */
export async function parseJsonBody<T>(
  c: Context,
  schema: ZodType<T>,
  options: ReadJsonOptions = {},
): Promise<Result<T>> {
  const raw = await readJsonBody(c, options);
  if (!raw.ok) return raw;
  const parsed = schema.safeParse(raw.value);
  return parsed.success ? ok(parsed.data) : fail("invalid_request", issueMessage(parsed.error));
}
