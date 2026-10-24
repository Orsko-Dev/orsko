/**
 * Direct-invocation detection for the `bin` entry point. Comparing
 * `import.meta.url` to a raw `file://${argv[1]}` string breaks whenever the
 * bin is reached through a symlink (npx, `node_modules/.bin`) or a path that
 * needs URL-escaping (spaces), because the module URL is always the
 * fully-resolved, escaped path while `argv[1]` is whatever the shell passed
 * in. Resolving symlinks and going through `pathToFileURL` keeps both sides
 * in the same form.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when this module was invoked directly as the process entry point
 * (`node dist/index.js`, a symlinked bin, `npx orsko-channel`, …) rather than
 * imported from another module. Any failure to resolve `argv1` (missing,
 * deleted, permission error) is treated as "not invoked directly" so the
 * import-only case never accidentally runs `main()`.
 */
export function isInvokedDirectly(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
