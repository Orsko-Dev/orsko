import { describe, expect, it } from "vitest";
import { FEEDBACK_MESSAGE_MAX_CHARS } from "../../src/config/constants";
import { feedbackEmail } from "../../src/feedback/email";
import { FeedbackBody } from "../../src/feedback/schema";

const FROM = "Orsko <signin@notifications.orsko.dev>";

describe("FeedbackBody", () => {
  it("accepts a plain message", () => {
    const parsed = FeedbackBody.safeParse({ message: "The room page is great." });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.message).toBe("The room page is great.");
  });

  it("trims the message and rejects one that is only whitespace", () => {
    expect(FeedbackBody.safeParse({ message: "  spaced out  " }).data?.message).toBe("spaced out");
    expect(FeedbackBody.safeParse({ message: "   " }).success).toBe(false);
    expect(FeedbackBody.safeParse({ message: "" }).success).toBe(false);
  });

  it("rejects a message longer than the limit", () => {
    expect(
      FeedbackBody.safeParse({ message: "x".repeat(FEEDBACK_MESSAGE_MAX_CHARS) }).success,
    ).toBe(true);
    expect(
      FeedbackBody.safeParse({ message: "x".repeat(FEEDBACK_MESSAGE_MAX_CHARS + 1) }).success,
    ).toBe(false);
  });

  it("takes an optional reply address and refuses one that is not an address", () => {
    expect(FeedbackBody.safeParse({ message: "hi", contact: "a@b.dev" }).data?.contact).toBe(
      "a@b.dev",
    );
    expect(FeedbackBody.safeParse({ message: "hi", contact: "not-an-address" }).success).toBe(
      false,
    );
    // Anonymous is the default: no contact at all is fine.
    expect(FeedbackBody.safeParse({ message: "hi" }).data?.contact).toBeUndefined();
  });

  it("refuses fields it does not know", () => {
    expect(FeedbackBody.safeParse({ message: "hi", userId: "u_1" }).success).toBe(false);
  });
});

describe("feedbackEmail", () => {
  it("names the page, quotes nothing into the subject, and replies to the visitor", () => {
    const mail = feedbackEmail(
      { message: "Line one\nLine two", contact: "visitor@example.com", page: "/r/:room" },
      { from: FROM, to: "hello@orsko.dev" },
    );
    expect(mail.from).toBe(FROM);
    expect(mail.to).toEqual(["hello@orsko.dev"]);
    expect(mail.subject).toBe("Orsko feedback");
    expect(mail.reply_to).toBe("visitor@example.com");
    expect(mail.text).toContain("Line one\nLine two");
    expect(mail.text).toContain("/r/:room");
    expect(mail.text).toContain("visitor@example.com");
  });

  it("says so plainly when the visitor left no address", () => {
    const mail = feedbackEmail({ message: "anon note" }, { from: FROM, to: "hello@orsko.dev" });
    expect(mail.reply_to).toBeUndefined();
    expect(mail.text).toContain("no reply address");
  });
});
