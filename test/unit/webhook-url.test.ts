import { describe, expect, it } from "vitest";
import { isAllowedWebhookUrl, webhookUrlProblem } from "../../src/validation/webhook-url";

const OK = [
  "https://example.com/hook",
  "https://example.com:8443/hook?x=1",
  "https://deep.sub.example.co.uk/a/b",
  "http://localhost/hook",
  "http://localhost:8787/hook",
  "https://localhost:8787/hook",
  "http://127.0.0.1:8787/hook",
];

const REJECTED: readonly (readonly [string, string])[] = [
  ["", "must be an absolute http(s) url"],
  ["not a url", "must be an absolute http(s) url"],
  ["/relative/hook", "must be an absolute http(s) url"],
  ["ftp://example.com/hook", "must use https"],
  ["ws://example.com/hook", "must use https"],
  ["javascript:alert(1)", "must use https"],
  ["file:///etc/passwd", "must use https"],
  ["http://example.com/hook", "must use https"],
  ["https://user:pass@example.com/hook", "must not contain credentials"],
  ["https://user@example.com/hook", "must not contain credentials"],
  ["https://10.0.0.5/hook", "must not point at an ip address"],
  ["https://172.16.0.1/hook", "must not point at an ip address"],
  ["https://172.31.255.254/hook", "must not point at an ip address"],
  ["https://192.168.1.10/hook", "must not point at an ip address"],
  ["https://169.254.169.254/latest/meta-data", "must not point at an ip address"],
  ["https://0.0.0.0/hook", "must not point at an ip address"],
  ["https://8.8.8.8/hook", "must not point at an ip address"],
  ["https://[::1]/hook", "must not point at an ip address"],
  ["https://[fc00::1]/hook", "must not point at an ip address"],
  ["https://[fd12:3456::1]/hook", "must not point at an ip address"],
  ["https://[2606:4700::1111]/hook", "must not point at an ip address"],
  ["http://127.0.0.2/hook", "must use https"],
  // Heuristics: a hostname that carries an address, or names something that
  // only exists inside a network.
  ["https://10.0.0.1.nip.io/hook", "must not point at an ip address"],
  ["https://169-254-169-254.sslip.io/hook", "must not point at an ip address"],
  ["https://host-192-168-1-10.example.com/hook", "must not point at an ip address"],
  [
    "https://metadata.google.internal/computeMetadata/v1/",
    "must not point at an internal hostname",
  ],
  ["https://build.internal/hook", "must not point at an internal hostname"],
  ["https://printer.local/hook", "must not point at an internal hostname"],
  ["https://app.localhost/hook", "must not point at an internal hostname"],
  ["https://example.arpa/hook", "must not point at an internal hostname"],
  ["https://intranet/hook", "must not point at an internal hostname"],
  ["https://build.internal./hook", "must not point at an internal hostname"],
];

describe("webhook url validation", () => {
  it.each(OK)("accepts %s", (url) => {
    expect(webhookUrlProblem(url)).toBeNull();
    expect(isAllowedWebhookUrl(url)).toBe(true);
  });

  it.each(REJECTED)("rejects %s", (url, problem) => {
    expect(webhookUrlProblem(url)).toContain(problem);
    expect(isAllowedWebhookUrl(url)).toBe(false);
  });

  it("rejects a url longer than 2048 characters", () => {
    const long = `https://example.com/${"a".repeat(2048)}`;
    expect(webhookUrlProblem(long)).toContain("2048");
    expect(isAllowedWebhookUrl(long)).toBe(false);
    expect(isAllowedWebhookUrl(`https://example.com/${"a".repeat(2028)}`)).toBe(true);
  });

  it("rejects a private address reached through a non-default port", () => {
    expect(isAllowedWebhookUrl("https://192.168.0.1:9000/hook")).toBe(false);
  });
});
