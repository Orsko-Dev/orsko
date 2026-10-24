import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { MCP_INSTRUCTIONS } from "../../src/mcp/copy";
import { BASE, createRoomViaHttp } from "../helpers";
import { callTool, errorOf, listTools, MCP_HEADERS, rpc, type ToolResult } from "../mcp";

describe("POST /mcp", () => {
  it("answers initialize with the Orsko server and its instructions", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orsko-test", version: "1.0.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as {
      result: {
        serverInfo: { name: string };
        instructions: string;
        capabilities: { tools?: unknown };
      };
    };
    expect(body.result.serverInfo.name).toBe("orsko");
    expect(body.result.instructions).toBe(MCP_INSTRUCTIONS);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists orsko_members with its input schema and annotations", async () => {
    const tools = await listTools();
    const members = tools.find((t) => t.name === "orsko_members");
    expect(members).toBeDefined();
    expect(members?.inputSchema.type).toBe("object");
    expect(Object.keys(members?.inputSchema.properties ?? {}).sort()).toEqual(["room", "token"]);
    expect(members?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it("describes the room field without hardcoding a host the Worker can supply", async () => {
    const tools = await listTools();
    const members = tools.find((t) => t.name === "orsko_members");
    const roomDescription = members?.inputSchema.properties?.room?.description as string;
    expect(roomDescription).toBeDefined();
    expect(roomDescription).not.toContain("orsko.dev");
    expect(roomDescription).toContain("/r/<id>");
  });

  it("runs stateless: a tool call needs no initialize first", async () => {
    const result = await callTool("orsko_members", { room: "not a room", token: "t" });
    expect(errorOf(result)).toEqual({
      code: "invalid_request",
      message: "room must be a room link, a /r/<id> path or a 12-character room id",
    });
  });

  it("answers GET and DELETE with 405 and Allow: POST", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await SELF.fetch(`${BASE}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32000);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("refuses a body over the cap with 413", async () => {
    const { MCP_MAX_BODY_BYTES } = await import("../../src/config/constants");
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: "x".repeat(MCP_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  });

  it("answers malformed JSON with a parse error", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: "{nope",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("passes the request to the SDK transport", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(406);
  });

  it("logs an SDK-raised transport error by class only, never its message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(406);
    const line = spy.mock.calls
      .map((call) => call[0] as string)
      .find((l) => l.includes("mcp.transport_error"));
    expect(line).toBeDefined();
    expect(line).not.toContain("Not Acceptable");
    const parsed = JSON.parse(line as string) as {
      level: string;
      event: string;
      errorClass: string;
    };
    expect(parsed).toMatchObject({
      level: "error",
      event: "mcp.transport_error",
      errorClass: "Error",
    });
    spy.mockRestore();
  });

  it("refuses a JSON-RPC batch (an array body) with 400 and -32600", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "orsko_join", arguments: { room: roomId, name: "batchjoin" } },
        },
      ]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toBe("Batch requests are not supported");

    const meta = (await (await SELF.fetch(`${BASE}/api/rooms/${roomId}`)).json()) as {
      members: readonly { name: string }[];
    };
    expect(meta.members.some((m) => m.name === "batchjoin")).toBe(false);
  });

  it("refuses an empty-array body with 400 and -32600", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: "[]",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toBe("Batch requests are not supported");
  });

  it("still answers a single request object normally", async () => {
    const res = await rpc("tools/list");
    expect(res.status).toBe(200);
  });

  it("answers OPTIONS with 405 and no CORS headers, since /mcp is not cross-origin", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never asks for authentication", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await rpc("tools/call", {
      name: "orsko_members",
      arguments: { room: roomId, token: "not-a-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = (await res.json()) as { result: ToolResult };
    expect(errorOf(body.result).code).toBe("invalid_token");
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ])("%s answers a JSON 404", async (path) => {
    const res = await SELF.fetch(`${BASE}${path}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
