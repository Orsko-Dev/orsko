import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isInvokedDirectly } from "../src/entry.js";

describe("isInvokedDirectly", () => {
  const dirs: string[] = [];

  afterEach(() => {
    dirs.length = 0;
  });

  function tmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orsko-entry-"));
    dirs.push(dir);
    return dir;
  }

  it("matches when argv1 equals the module's own resolved path", () => {
    const dir = tmpDir();
    const file = path.join(dir, "index.js");
    writeFileSync(file, "");
    // Node's module loader reports import.meta.url as the fully-resolved
    // (symlink-free) path, even when argv[1] and the tmp dir itself are not
    // symlinks -- mirror that so the test reflects real invocation.
    const moduleUrl = pathToFileURL(realpathSync(file)).href;
    expect(isInvokedDirectly(file, moduleUrl)).toBe(true);
  });

  it("matches through a symlink (npx / node_modules/.bin style invocation)", () => {
    const dir = tmpDir();
    const real = path.join(dir, "real-index.js");
    writeFileSync(real, "");
    const link = path.join(dir, "orsko-channel");
    symlinkSync(real, link);
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    // The shell passes the symlink path in argv[1]; the module URL Node
    // reports is the resolved target.
    expect(isInvokedDirectly(link, moduleUrl)).toBe(true);
  });

  it("matches when the path contains a space", () => {
    const dir = tmpDir();
    const sub = path.join(dir, "has space");
    mkdirSync(sub);
    const file = path.join(sub, "index.js");
    writeFileSync(file, "");
    const moduleUrl = pathToFileURL(realpathSync(file)).href;
    expect(isInvokedDirectly(file, moduleUrl)).toBe(true);
  });

  it("returns false when argv1 is undefined", () => {
    expect(isInvokedDirectly(undefined, "file:///anything")).toBe(false);
  });

  it("returns false when argv1 does not resolve to the module url", () => {
    const dir = tmpDir();
    const file = path.join(dir, "other.js");
    writeFileSync(file, "");
    expect(isInvokedDirectly(file, "file:///not/the/same/file.js")).toBe(false);
  });

  it("returns false, not throw, when argv1 does not exist on disk", () => {
    const missing = path.join(tmpDir(), "does-not-exist.js");
    expect(isInvokedDirectly(missing, pathToFileURL(missing).href)).toBe(false);
  });
});
