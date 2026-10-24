import type { D1Migration } from "cloudflare:test";

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

/** Vite serves `?raw` imports as the file's exact bytes; fixtures rely on it. */
declare module "*.html?raw" {
  const content: string;
  export default content;
}

/** Same as above, for reading wrangler.jsonc without filesystem access in the test pool. */
declare module "*.jsonc?raw" {
  const content: string;
  export default content;
}

/** The same, for the open-source files: licences, policies and package manifests. */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
declare module "*.json?raw" {
  const content: string;
  export default content;
}
declare module "*/LICENSE?raw" {
  const content: string;
  export default content;
}
