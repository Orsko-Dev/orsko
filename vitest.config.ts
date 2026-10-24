import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The stream handshake deadline is ten seconds in production; tests
        // must not wait that long to see a 4408. TEST_MIGRATIONS carries the
        // parsed D1 migrations so test/setup.ts can apply them before any
        // test runs.
        bindings: {
          STREAM_HELLO_TIMEOUT_MS: "200",
          INVITE_MINT_LIMIT_PER_HOUR: "5",
          GITHUB_CLIENT_ID: "test-id",
          GITHUB_CLIENT_SECRET: "test-secret",
          RESEND_API_KEY: "re_test",
          COOKIE_SECRET: "cookie-secret-for-tests",
          MAGIC_LINK_FROM: "Orsko <signin@notifications.orsko.dev>",
          // Server-side PostHog events are off in tests, so the suite never
          // writes into the real project; the /lens proxy tests mock fetch.
          POSTHOG_PROJECT_TOKEN: "",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/env.ts", "src/room/types.ts"],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
}));
