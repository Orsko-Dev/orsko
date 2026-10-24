import { JSON_RPC_PARSE_ERROR, JSON_RPC_SERVER_ERROR } from "../config/constants";
import { logFailure } from "../util/log";

export type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response };

/** A JSON-RPC error response in the shape the SDK's own transport uses. */
export function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tooLarge(maxBytes: number): Response {
  return jsonRpcError(413, JSON_RPC_SERVER_ERROR, `Request body exceeds ${maxBytes} bytes`);
}

function parseError(): Response {
  return jsonRpcError(400, JSON_RPC_PARSE_ERROR, "Parse error: Invalid JSON");
}

/**
 * Reads a request body up to `maxBytes`, refusing anything larger before it
 * reaches the MCP SDK. A declared `content-length` over the cap is refused
 * without reading the body at all; otherwise the stream is read while
 * counting bytes, and cancelled the moment the count passes the cap.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<BodyRead> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes)
    return { ok: false, response: tooLarge(maxBytes) };

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: parseError() };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, response: tooLarge(maxBytes) };
      }
      chunks.push(value);
    }
  } catch (error) {
    // A disconnected client or a broken stream rejects read()/cancel() rather
    // than resolving. That is unreadable input the same as invalid JSON, so
    // it is reported the same way: never a bare 500 from Hono's own onError.
    logFailure("mcp.body_read_failed", {
      errorClass: error instanceof Error ? error.name : "unknown_error",
    });
    return { ok: false, response: parseError() };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return { ok: false, response: parseError() };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, response: parseError() };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: parseError() };
  }
}
