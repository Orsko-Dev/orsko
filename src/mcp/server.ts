import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { NO_TRACKING, type RoomTracker } from "../analytics/track";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../config/constants";
import type { Env } from "../env";
import { MCP_INSTRUCTIONS } from "./copy";
import { registerRecordTools } from "./tools-records";
import { registerSessionTools } from "./tools-session";

/**
 * Builds a fresh server for one request. The connector is stateless (see
 * `route.ts`), so a new `McpServer` is constructed and torn down per POST
 * rather than kept alive across requests. `track` records room joins made
 * through the connector; it defaults to no tracking.
 */
export function createMcpServer(env: Env, track: RoomTracker = NO_TRACKING): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  registerSessionTools(server, env, track);
  registerRecordTools(server, env);
  return server;
}
