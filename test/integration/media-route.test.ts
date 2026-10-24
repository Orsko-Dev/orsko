import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "../helpers";

const VIDEO = "/media/orsko-launch.mp4";

async function assetBytes(path: string): Promise<Uint8Array> {
  const res = await env.ASSETS.fetch(new URL(path, BASE));
  return new Uint8Array(await res.arrayBuffer());
}

/** Hex SHA-256, so a multi-megabyte body is compared without an element-wise deep equal. */
async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Safari (and iOS in particular) only plays <video> from a server that answers
// byte-range requests with 206, so the Worker serves /media/* itself.
describe("media route", () => {
  it("answers a whole-file request with 200 and advertises byte ranges", async () => {
    const whole = await assetBytes(VIDEO);
    const res = await SELF.fetch(`${BASE}${VIDEO}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(whole.byteLength));
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(whole.byteLength);
    expect(await sha256(body)).toBe(await sha256(whole));
  });

  it("answers a byte range with 206 and exactly those bytes", async () => {
    const whole = await assetBytes(VIDEO);
    const res = await SELF.fetch(`${BASE}${VIDEO}`, { headers: { range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${whole.byteLength}`);
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toContain("video/mp4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole.slice(0, 2));
  });

  it("answers an open-ended range from the offset to the last byte", async () => {
    const whole = await assetBytes(VIDEO);
    const start = whole.byteLength - 1024;
    const res = await SELF.fetch(`${BASE}${VIDEO}`, { headers: { range: `bytes=${start}-` } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes ${start}-${whole.byteLength - 1}/${whole.byteLength}`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(whole.slice(start));
  });

  it("answers a range past the end with 416 and the real size", async () => {
    const whole = await assetBytes(VIDEO);
    const res = await SELF.fetch(`${BASE}${VIDEO}`, {
      headers: { range: `bytes=${whole.byteLength}-` },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${whole.byteLength}`);
  });

  it("answers HEAD with the headers and no body", async () => {
    const whole = await assetBytes(VIDEO);
    const res = await SELF.fetch(`${BASE}${VIDEO}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(whole.byteLength));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("serves the poster through the same route", async () => {
    const res = await SELF.fetch(`${BASE}/media/orsko-launch-poster.jpg`, {
      headers: { range: "bytes=0-2" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toContain("image/jpeg");
    // A JPEG starts with the SOI marker FF D8 FF.
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("returns 404 for a media file that does not exist", async () => {
    const res = await SELF.fetch(`${BASE}/media/missing.mp4`, { headers: { range: "bytes=0-1" } });
    expect(res.status).toBe(404);
  });
});
