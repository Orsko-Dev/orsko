import { describe, expect, it } from "vitest";
import { detectSecrets, secretRejectionMessage } from "../../src/validation/secrets";

function kinds(text: string): string[] {
  return detectSecrets(text).map((h) => h.kind);
}

describe("detectSecrets: one case per kind", () => {
  it("finds an AWS access key id", () => {
    expect(kinds("key AKIAIOSFODNN7EXAMPLE here")).toEqual(["aws_access_key"]);
    expect(kinds("key ASIAIOSFODNN7EXAMPLE here")).toEqual(["aws_access_key"]);
  });

  it("finds GitHub tokens in both shapes", () => {
    expect(kinds(`use ghp_${"a1B2c3D4e5".repeat(3)}abcdef now`)).toEqual(["github_token"]);
    expect(kinds(`use github_pat_${"A1b2c3d4e5_".repeat(6)} now`)).toEqual(["github_token"]);
  });

  it("finds a Slack token", () => {
    expect(kinds("xoxb-123456789012-abcdefghijkl")).toEqual(["slack_token"]);
  });

  it("finds an OpenAI key", () => {
    expect(kinds(`sk-${"A1b2c3d4".repeat(5)}`)).toEqual(["openai_key"]);
    expect(kinds(`sk-proj-${"A1b2c3d4".repeat(5)}`)).toEqual(["openai_key"]);
  });

  it("reports an Anthropic key under the specific kind only", () => {
    expect(kinds(`sk-ant-${"A1b2c3d4".repeat(5)}`)).toEqual(["anthropic_key"]);
  });

  it("still reports an OpenAI key alongside an Anthropic one", () => {
    const text = `sk-ant-${"A1b2c3d4".repeat(5)} and sk-proj-${"Z9y8x7w6".repeat(5)}`;
    expect(kinds(text).sort()).toEqual(["anthropic_key", "openai_key"]);
  });

  it("finds a Google API key", () => {
    expect(kinds(`AIza${"A1b2c3d4e".repeat(3)}12345678`)).toEqual(["google_api_key"]);
  });

  it("finds a Stripe key", () => {
    expect(kinds("sk_live_abcdefghij0123456789")).toEqual(["stripe_key"]);
    expect(kinds("rk_test_abcdefghij0123456789")).toEqual(["stripe_key"]);
  });

  it("finds a private key block", () => {
    expect(kinds("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toEqual(["private_key_block"]);
    expect(kinds("-----BEGIN PRIVATE KEY-----")).toEqual(["private_key_block"]);
  });

  it("finds a JWT", () => {
    expect(
      kinds("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g"),
    ).toEqual(["jwt"]);
  });

  it("finds a password inside a connection string", () => {
    expect(kinds("postgres://app:hunter2pass@db.internal:5432/main")).toEqual([
      "connection_string_password",
    ]);
    expect(kinds("mongodb://u:s3cretpw@cluster0.example.net/db")).toEqual([
      "connection_string_password",
    ]);
    expect(kinds("https://admin:letmein99@dashboard.example.com/x")).toEqual([
      "connection_string_password",
    ]);
    expect(kinds("postgres://app:S3cretPassw0rd@db.internal:5432/prod")).toEqual([
      "connection_string_password",
    ]);
  });

  it("finds a password assignment", () => {
    expect(kinds("password=hunter2hunter2")).toEqual(["password_assignment"]);
    expect(kinds('PASSWORD: "s3cret-value-1"')).toEqual(["password_assignment"]);
    expect(kinds("api_key = ab12cd34ef56")).toEqual(["password_assignment"]);
    expect(kinds("pwd:'ab12cd34ef56'")).toEqual(["password_assignment"]);
  });

  it("finds a real password that happens to start with a dollar sign", () => {
    expect(kinds("postgres://user:$ecretPassw0rd99@db.internal:5432/prod")).toEqual([
      "connection_string_password",
    ]);
    expect(kinds("password = $ecretPassw0rd99")).toEqual(["password_assignment"]);
  });
});

describe("detectSecrets: benign text passes", () => {
  const benign = [
    "token = bearerToken(c)",
    "password: string",
    "API_KEY=<your key>",
    "const apiKey = process.env.API_KEY;",
    "set password to something memorable",
    "password = xxxxxxxxxx",
    "secret: ****************",
    "PASSWORD=changeme",
    "token: your-token-here",
    "api-key: example-value-1",
    "password: REDACTED",
    "postgres://app@db.internal:5432/main",
    "API_KEY=<your key>\nDATABASE_URL=postgres://user:<password>@localhost/db",
    "postgres://user:{password}@localhost/db",
    // Split so the literal is not read as an unintended template string.
    "postgres://user:$" + "{DB_PASSWORD}@localhost/db",
    "postgres://user:%(password)s@localhost/db",
    "postgres://user:$DB_PASS@localhost/db",
    "postgres://user:xxxxxxxx@localhost/db",
    "postgres://user:changeme@localhost/db",
    "postgres://user:redacted@localhost/db",
    "postgres://user:your-password@localhost/db",
    "postgres://user:example-value@localhost/db",
    "postgres://user:password@localhost/db",
    "postgres://user:secret@localhost/db",
    "see https://example.com/docs/postgres for the DSN format",
    "the deploy uses sk_live_ prefixed keys",
    "Authorization: Bearer <token>",
    "pwd is short",
    "AKIA is the prefix of an AWS key id",
  ];

  for (const text of benign) {
    it(`passes: ${text}`, () => {
      expect(detectSecrets(text)).toEqual([]);
    });
  }
});

describe("detectSecrets: shape of results", () => {
  it("deduplicates repeated kinds and reports every kind found", () => {
    const text = "AKIAIOSFODNN7EXAMPLE AKIAIOSFODNN7EXAMPLB postgres://a:secret99@h/db";
    expect(kinds(text).sort()).toEqual(["aws_access_key", "connection_string_password"]);
  });

  it("carries a human label for every hit", () => {
    for (const hit of detectSecrets("AKIAIOSFODNN7EXAMPLE")) {
      expect(hit.label.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing for empty text", () => {
    expect(detectSecrets("")).toEqual([]);
  });

  it("scans 32 KiB of benign text in under 20 ms", () => {
    const chunk = "function bearerToken(c) { return c.req.header('authorization'); } // ok\n";
    const text = chunk.repeat(Math.ceil(32768 / chunk.length)).slice(0, 32768);
    const started = Date.now();
    expect(detectSecrets(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(20);
  });
});

describe("secretRejectionMessage", () => {
  it("names the kind and says what to do without echoing the secret", () => {
    const message = secretRejectionMessage(
      detectSecrets("postgres://app:hunter2pass@db.internal:5432/main"),
    );
    expect(message).toBe(
      "message contains what looks like a database password in a connection string; redact it and post again",
    );
    expect(message).not.toContain("hunter2pass");
  });

  it("lists every kind found", () => {
    const message = secretRejectionMessage(
      detectSecrets("AKIAIOSFODNN7EXAMPLE and sk_live_abcdefghij0123456789"),
    );
    expect(message).toContain("an AWS access key id");
    expect(message).toContain("a Stripe secret key");
    expect(message).toContain("redact");
  });
});
