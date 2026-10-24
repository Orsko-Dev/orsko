import { SELF } from "cloudflare:test";
import { BASE } from "./helpers";

export const MCP_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: string;
    readonly properties?: Record<string, Record<string, unknown>>;
  };
  readonly annotations?: Record<string, unknown>;
}
export interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}
let nextId = 1;
export function rpc(method: string, params: Record<string, unknown> = {}): Promise<Response> {
  const id = nextId;
  nextId += 1;
  return SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}
export async function listTools(): Promise<ListedTool[]> {
  const res = await rpc("tools/list");
  if (res.status !== 200) throw new Error(`tools/list answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { result: { tools: ListedTool[] } }).result.tools;
}
export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.status !== 200)
    throw new Error(`tools/call ${name} answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { result?: ToolResult };
  if (!body.result) throw new Error(`tools/call ${name} returned no result`);
  return body.result;
}
/** The structured value of a successful tool result; fails the test on a tool error. */
export function toolValue<T>(result: ToolResult): T {
  if (result.isError) throw new Error(`tool error: ${result.content[0]?.text ?? ""}`);
  return result.structuredContent as T;
}
/** The {"error":{...}} body a room error carries (not SDK input validation errors, which are plain text). */
export function errorOf(result: ToolResult): { code: string; message: string } {
  if (!result.isError) throw new Error("expected a tool error");
  return (
    JSON.parse(result.content[0]?.text ?? "{}") as { error: { code: string; message: string } }
  ).error;
}
