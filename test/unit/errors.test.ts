import { describe, expect, it } from "vitest";
import { AppError, errorBody, fail, httpStatusFor, ok } from "../../src/validation/errors";

describe("errors", () => {
  it("maps codes to statuses", () => {
    expect(httpStatusFor("room_not_found")).toBe(404);
    expect(httpStatusFor("room_archived")).toBe(410);
    expect(httpStatusFor("name_taken")).toBe(409);
    expect(httpStatusFor("room_full")).toBe(409);
    expect(httpStatusFor("invalid_token")).toBe(401);
    expect(httpStatusFor("forbidden")).toBe(403);
    expect(httpStatusFor("message_too_large")).toBe(413);
    expect(httpStatusFor("secret_detected")).toBe(422);
    expect(httpStatusFor("attachment_too_large")).toBe(413);
    expect(httpStatusFor("too_many_messages")).toBe(409);
    expect(httpStatusFor("too_many_attachments")).toBe(409);
    expect(httpStatusFor("attachment_not_found")).toBe(404);
    expect(httpStatusFor("not_found")).toBe(404);
    expect(httpStatusFor("rate_limited")).toBe(429);
    expect(httpStatusFor("create_rate_limited")).toBe(429);
    expect(httpStatusFor("invalid_request")).toBe(400);
    expect(httpStatusFor("internal")).toBe(500);
  });

  it("builds error bodies with optional retry", () => {
    expect(errorBody("rate_limited", "slow down", 30)).toEqual({
      error: { code: "rate_limited", message: "slow down", retryAfterSeconds: 30 },
    });
    expect(errorBody("internal", "boom")).toEqual({ error: { code: "internal", message: "boom" } });
  });

  it("AppError carries code and retry", () => {
    const e = new AppError("rate_limited", "wait", 5);
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterSeconds).toBe(5);
    expect(e.message).toBe("wait");
  });

  it("ok and fail build Result values", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(fail("name_taken", "taken")).toEqual({
      ok: false,
      code: "name_taken",
      message: "taken",
    });
  });
});
