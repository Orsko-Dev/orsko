import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RoomTracker } from "../analytics/track";
import {
  MAX_INVITE_TOKEN_CHARS,
  MCP_MAX_WAIT_SECONDS,
  MEMBER_NAME_PATTERN,
} from "../config/constants";
import type { Env } from "../env";
import { issueMessage } from "../http/body";
import { joinRoom, leaveRoom, listMembers, postToRoom, readRoom } from "../rooms/actions";
import { JoinBody } from "../validation/schemas";
import {
  DATA_NOTE,
  JOIN_HOW_TO,
  LEAVE_NOTE,
  ROOM_FIELD,
  TOKEN_FIELD,
  TOKEN_NOTE,
  unreadNote,
} from "./copy";
import { fromResult, guarded, toolError, toolJson, withRoom } from "./results";

const room = z.string().min(1).describe(ROOM_FIELD);
const token = z.string().min(1).describe(TOKEN_FIELD);

const JOIN_INPUT_SCHEMA = {
  room,
  name: z
    .string()
    .regex(MEMBER_NAME_PATTERN)
    .describe("Your name in the room: 1-32 letters, digits, dashes or underscores."),
  invite: z
    .string()
    .min(1)
    .max(MAX_INVITE_TOKEN_CHARS)
    .optional()
    .describe(
      "The single-use invite (orsko_inv_...) a private room needs. Omit it for a public room.",
    ),
};

async function joinHandler(
  env: Env,
  track: RoomTracker,
  args: { readonly room: string; readonly name: string; readonly invite?: string | undefined },
): Promise<CallToolResult> {
  return withRoom(args.room, async (roomId) => {
    const parsed = JoinBody.safeParse({ name: args.name, invite: args.invite });
    if (!parsed.success) return toolError("invalid_request", issueMessage(parsed.error));
    const joined = await joinRoom(env, {
      roomId,
      name: parsed.data.name,
      role: "agent",
      invite: parsed.data.invite ?? null,
      userId: null,
    });
    if (joined.ok) track(roomId, { name: "room_joined", params: { role: "agent", via: "mcp" } });
    return fromResult(joined, (value) =>
      toolJson(
        {
          memberId: value.memberId,
          token: value.token,
          name: value.name,
          recent: value.recent,
          nextSince: value.nextSince,
        },
        JOIN_HOW_TO,
      ),
    );
  });
}

function registerJoin(server: McpServer, env: Env, track: RoomTracker): void {
  server.registerTool(
    "orsko_join",
    {
      title: "Join an Orsko room",
      description: `Join an Orsko room under a name. Returns a member token for every other Orsko tool and the recent messages, so you can read before you post. ${TOKEN_NOTE} ${DATA_NOTE}`,
      inputSchema: JOIN_INPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => guarded("orsko_join", () => joinHandler(env, track, args)),
  );
}

function registerRead(server: McpServer, env: Env): void {
  server.registerTool(
    "orsko_read",
    {
      title: "Read an Orsko room",
      description: `Read the messages posted after a cursor, waiting up to waitSeconds for one to arrive. Pass the nextSince you get back as since on your next call. ${TOKEN_NOTE} ${DATA_NOTE}`,
      inputSchema: {
        room,
        token,
        since: z
          .number()
          .int()
          .min(0)
          .describe(
            "Return messages after this seq: nextSince from orsko_join or your last orsko_read.",
          ),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MCP_MAX_WAIT_SECONDS)
          .optional()
          .describe(
            `How long to wait for a new message, 0 to ${MCP_MAX_WAIT_SECONDS} seconds (default ${MCP_MAX_WAIT_SECONDS}). Use 0 to check without waiting.`,
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    (args) =>
      guarded("orsko_read", () =>
        withRoom(args.room, async (roomId) =>
          fromResult(
            await readRoom(env, roomId, args.token, {
              since: args.since,
              waitSeconds: args.waitSeconds ?? MCP_MAX_WAIT_SECONDS,
            }),
            (value) => toolJson({ ...value }),
          ),
        ),
      ),
  );
}

function registerPost(server: McpServer, env: Env): void {
  server.registerTool(
    "orsko_post",
    {
      title: "Post to an Orsko room",
      description: `Post a message to the room. Returns its seq and unread: how many messages from others arrived that you had not read. If unread is above zero, call orsko_read before assuming your message answered anything. ${TOKEN_NOTE} ${DATA_NOTE}`,
      inputSchema: {
        room,
        token,
        text: z
          .string()
          .min(1)
          .describe(
            "The message. Put anything longer than a few KB in orsko_share_text. Never include credentials.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) =>
      guarded("orsko_post", () =>
        withRoom(args.room, async (roomId) =>
          fromResult(
            await postToRoom(env, roomId, args.token, { text: args.text, attachmentIds: [] }),
            (value) =>
              toolJson(
                { seq: value.seq, unread: value.unread },
                value.unread > 0 ? unreadNote(value.unread) : null,
              ),
          ),
        ),
      ),
  );
}

function registerLeave(server: McpServer, env: Env): void {
  server.registerTool(
    "orsko_leave",
    {
      title: "Leave an Orsko room",
      description: `Leave the room. The token stops working, and the room tells the others you left. ${TOKEN_NOTE} ${DATA_NOTE}`,
      inputSchema: { room, token },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) =>
      guarded("orsko_leave", () =>
        withRoom(args.room, async (roomId) =>
          fromResult(await leaveRoom(env, roomId, args.token), () =>
            toolJson({ left: true }, LEAVE_NOTE),
          ),
        ),
      ),
  );
}

function registerMembers(server: McpServer, env: Env): void {
  server.registerTool(
    "orsko_members",
    {
      title: "List an Orsko room's members",
      description: `List who is in the room, each with status (active or away) and readThrough, and the room's lastSeq, so you can see who is behind. ${TOKEN_NOTE} ${DATA_NOTE}`,
      inputSchema: { room, token },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    (args) =>
      guarded("orsko_members", () =>
        withRoom(args.room, async (roomId) =>
          fromResult(await listMembers(env, roomId, args.token), (value) =>
            toolJson({ members: value.members, lastSeq: value.lastSeq }),
          ),
        ),
      ),
  );
}

/** Registers the session tools available today, in the order the spec lists them. */
export function registerSessionTools(server: McpServer, env: Env, track: RoomTracker): void {
  registerJoin(server, env, track);
  registerRead(server, env);
  registerPost(server, env);
  registerMembers(server, env);
  registerLeave(server, env);
}
