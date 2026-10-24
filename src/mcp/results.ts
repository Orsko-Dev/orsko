import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logFailure } from "../util/log";
import type { ErrorCode, Result } from "../validation/errors";
import { errorBody } from "../validation/errors";
import { parseRoomReference } from "./room-ref";

export const TOOL_FAILED_MESSAGE = "Orsko could not complete that request";

/** A room error, carried as the API's own `{"error":{...}}` body as text. */
export function toolError(
  code: ErrorCode,
  message: string,
  retryAfterSeconds?: number,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(errorBody(code, message, retryAfterSeconds)) }],
    isError: true,
  };
}

/** A successful tool result: the value as JSON text plus structured content, with an optional note. */
export function toolJson(
  value: Record<string, unknown>,
  note: string | null = null,
): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(value) }];
  if (note !== null) content.push({ type: "text", text: note });
  return { content, structuredContent: value };
}

/** Maps a shared action's `Result` to a tool result, success or room error alike. */
export function fromResult<T>(
  result: Result<T>,
  present: (value: T) => CallToolResult,
): CallToolResult {
  return result.ok
    ? present(result.value)
    : toolError(result.code, result.message, result.retryAfterSeconds);
}

/**
 * Resolves the room argument before running the tool body. An unreadable
 * room reference never reaches a shared action.
 */
export async function withRoom(
  room: string,
  run: (roomId: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const roomId = parseRoomReference(room);
  if (roomId === null) {
    return toolError(
      "invalid_request",
      "room must be a room link, a /r/<id> path or a 12-character room id",
    );
  }
  return run(roomId);
}

/**
 * Wraps a tool handler so an unexpected exception never escapes the SDK as a
 * JSON-RPC error. The failure is logged with the tool name and the error's
 * class only: never the message, which could carry a token or room text.
 */
export async function guarded(
  tool: string,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    logFailure("mcp.tool_failed", {
      tool,
      errorClass: error instanceof Error ? error.name : "unknown_error",
    });
    return { content: [{ type: "text", text: TOOL_FAILED_MESSAGE }], isError: true };
  }
}
