import { Hono } from "hono";
import type { Env } from "../../env";
import { logFailure } from "../../util/log";
import { parseByteRange } from "../byte-range";
import { respondError } from "../respond";

/**
 * The bundled media files (the landing page's launch video and its poster).
 *
 * Workers Assets answers a `Range` request with the whole file and no
 * `Accept-Ranges`, and Safari — iOS above all — refuses to play a <video>
 * from such a server. wrangler.jsonc runs the Worker first for /media/*, and
 * this route serves the same bundled bytes with proper 206 / 416 handling.
 * Hono answers HEAD from this GET handler, without the body.
 *
 * Each file is read whole before slicing; media here is kept small (the
 * integration test pins it under the 25 MiB Workers Assets file limit).
 */
export const mediaRoutes = new Hono<{ Bindings: Env }>();

/** Headers copied from the bundled asset onto every media response. */
const PASSTHROUGH_HEADERS = ["content-type", "etag", "cache-control", "last-modified"] as const;

mediaRoutes.get("/:file", async (c) => {
  const asset = await c.env.ASSETS.fetch(new URL(c.req.path, c.req.url));
  if (asset.status === 404) return c.notFound();
  if (!asset.ok) {
    logFailure("media.asset_failed", { route: c.req.path, status: asset.status });
    return respondError(c, "internal", "media unavailable");
  }

  const bytes = new Uint8Array(await asset.arrayBuffer());
  const size = bytes.byteLength;
  const headers = new Headers({ "accept-ranges": "bytes" });
  for (const name of PASSTHROUGH_HEADERS) {
    const value = asset.headers.get(name);
    if (value) headers.set(name, value);
  }

  const range = parseByteRange(c.req.header("range") ?? null, size);
  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range.kind === "full") {
    headers.set("content-length", String(size));
    return new Response(bytes, { status: 200, headers });
  }

  const slice = bytes.subarray(range.start, range.end + 1);
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("content-length", String(slice.byteLength));
  return new Response(slice, { status: 206, headers });
});
