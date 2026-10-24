import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type ErrorCode, errorBody, httpStatusFor, type Result } from "../validation/errors";

export function respondError(
  c: Context,
  code: ErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const status = httpStatusFor(code) as ContentfulStatusCode;
  if (retryAfterSeconds !== undefined) c.header("Retry-After", String(retryAfterSeconds));
  return c.json(errorBody(code, message, retryAfterSeconds), status);
}

export function respondResult<T>(
  c: Context,
  result: Result<T>,
  status: ContentfulStatusCode = 200,
): Response {
  if (!result.ok) return respondError(c, result.code, result.message, result.retryAfterSeconds);
  return c.json(result.value as unknown as Record<string, unknown>, status);
}
