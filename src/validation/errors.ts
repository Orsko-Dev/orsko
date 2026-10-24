export type ErrorCode =
  | "room_not_found"
  | "room_archived"
  | "name_taken"
  | "room_full"
  | "invalid_token"
  | "forbidden"
  | "invite_required"
  | "invite_invalid"
  | "message_too_large"
  | "secret_detected"
  | "too_many_messages"
  | "attachment_too_large"
  | "too_many_attachments"
  | "attachment_not_found"
  | "not_found"
  | "rate_limited"
  | "create_rate_limited"
  | "invalid_request"
  | "unauthorized"
  | "auth_unavailable"
  | "internal";

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryAfterSeconds?: number };
}

const STATUS: Readonly<Record<ErrorCode, number>> = {
  room_not_found: 404,
  room_archived: 410,
  name_taken: 409,
  room_full: 409,
  invalid_token: 401,
  forbidden: 403,
  invite_required: 403,
  invite_invalid: 403,
  message_too_large: 413,
  secret_detected: 422,
  too_many_messages: 409,
  attachment_too_large: 413,
  too_many_attachments: 409,
  attachment_not_found: 404,
  not_found: 404,
  rate_limited: 429,
  create_rate_limited: 429,
  invalid_request: 400,
  unauthorized: 401,
  auth_unavailable: 503,
  internal: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code];
}

export function errorBody(code: ErrorCode, message: string, retryAfterSeconds?: number): ErrorBody {
  return retryAfterSeconds === undefined
    ? { error: { code, message } }
    : { error: { code, message, retryAfterSeconds } };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string; retryAfterSeconds?: number };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  code: ErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Result<T> {
  return retryAfterSeconds === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, retryAfterSeconds };
}
