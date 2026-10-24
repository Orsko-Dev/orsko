import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { trackerFor } from "../analytics/track";
import {
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_SERVER_ERROR,
  MCP_MAX_BODY_BYTES,
} from "../config/constants";
import type { Env } from "../env";
import { logFailure } from "../util/log";
import { jsonRpcError, readBoundedJson } from "./body";
import { createMcpServer } from "./server";

// /mcp is deliberately not cross-origin: every caller is a connector host
// process or an agent's own HTTP client, never a browser page, so it is kept
// out of the cors() scopes in index.ts and sends no CORS headers.
export const mcpApi = new Hono<{ Bindings: Env }>();

mcpApi.post("/", async (c) => {
  const body = await readBoundedJson(c.req.raw, MCP_MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  // The SDK transport dispatches every entry of an array body concurrently,
  // with no cap: one small request could otherwise carry thousands of
  // tools/call entries. Refused here, before any of them run.
  if (Array.isArray(body.value))
    return jsonRpcError(400, JSON_RPC_INVALID_REQUEST, "Batch requests are not supported");

  const server = createMcpServer(c.env, trackerFor(c));
  // No sessionIdGenerator: the transport runs stateless (exactOptionalPropertyTypes forbids an explicit undefined).
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  // The SDK raises 406/415/parse-error conditions through `onerror`, not by
  // throwing, so without this they pass through the server unobserved. Only
  // the error's class is logged: the message can echo request content.
  transport.onerror = (error) => {
    logFailure("mcp.transport_error", { errorClass: error.name });
  };
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw, { parsedBody: body.value });
  } finally {
    await server.close();
  }
});

// Stateless mode has no stream to open (GET) and no session to end (DELETE).
mcpApi.all("/", () =>
  jsonRpcError(405, JSON_RPC_SERVER_ERROR, "Method not allowed.", { Allow: "POST" }),
);
