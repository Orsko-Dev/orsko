import { describe, expect, it } from "vitest";
// Vite's `?raw` suffix inlines the file's text at bundle time, so this needs
// no filesystem access at runtime — the test pool sandboxes disk, so a plain
// `node:fs` read fails there even though the file exists on disk. Typed by
// the `*.jsonc?raw` declaration in test/env.d.ts.
import wranglerRaw from "../../wrangler.jsonc?raw";

/**
 * wrangler.jsonc has the .jsonc extension but is otherwise plain JSON; the
 * only comments in it are the standalone lines documenting
 * `assets.run_worker_first` below. Stripping whole lines that start with
 * `//` (after leading whitespace) is enough to parse it as JSON here — this
 * file never puts a comment after code on the same line, so a smarter
 * (string-aware) stripper is not needed. If that ever changes, this must
 * become a real JSONC parser instead of silently mis-parsing.
 */
function stripFullLineComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("wrangler.jsonc", () => {
  it("runs the Worker first for /connect, so Workers Assets never serves the raw asset", () => {
    const config = JSON.parse(stripFullLineComments(wranglerRaw));
    expect(config.assets.run_worker_first).toContain("/connect");
    expect(config.assets.run_worker_first).toContain("/connect.html");
    // Every other route must still fall through to Workers Assets directly.
    expect(config.assets.run_worker_first).toEqual(["/connect", "/connect.html", "/media/*"]);
  });

  it("runs the Worker first for /media/*, so video gets byte-range (206) responses", () => {
    const config = JSON.parse(stripFullLineComments(wranglerRaw));
    expect(config.assets.run_worker_first).toContain("/media/*");
  });
});
