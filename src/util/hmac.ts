/**
 * HMAC-SHA256 over the raw UTF-8 bytes of `body`, hex encoded. Web Crypto is
 * the only implementation available in the Workers runtime, and importKey is
 * per-call: the keys here are per-member webhook secrets, so there is nothing
 * long-lived worth caching.
 */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}
