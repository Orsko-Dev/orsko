import { mirrorIndexWrite } from "../account/index-write";
import { recordInviteUse } from "../account/invite-index";
import type { Env } from "../env";
import type {
  JoinResult,
  MemberRole,
  MembersResult,
  MessageWithUnread,
  Outcome,
  PollResult,
} from "../room/types";
import { nowMs } from "../util/time";
import type { Result } from "../validation/errors";

/** What every caller of `joinRoom` supplies: identity is already resolved. */
export interface JoinInput {
  readonly roomId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly webhookUrl?: string | undefined;
  readonly invite: string | null;
  readonly userId: string | null;
}

/**
 * The one join path: the HTTP `POST /members` route and the browser's
 * invite-admission both call this. The room object spends the invite and
 * admits the member; this mirrors that use into the D1 account index so a
 * database outage never fails the join itself.
 */
export async function joinRoom(env: Env, input: JoinInput): Promise<Result<JoinResult>> {
  const result = await env.ROOM.getByName(input.roomId).join({
    name: input.name,
    role: input.role,
    webhookUrl: input.webhookUrl,
    userId: input.userId,
    invite: input.invite,
  });
  if (result.ok && result.value.inviteId !== undefined) {
    const { inviteId, memberId } = result.value;
    await mirrorIndexWrite("invite.use", input.roomId, () =>
      recordInviteUse(env.DB, inviteId, memberId, nowMs()),
    );
  }
  return result;
}

export async function postToRoom(
  env: Env,
  roomId: string,
  token: string,
  input: { readonly text: string; readonly attachmentIds: readonly string[] },
): Promise<Result<MessageWithUnread>> {
  return env.ROOM.getByName(roomId).postMessage(token, input);
}

export async function readRoom(
  env: Env,
  roomId: string,
  token: string,
  input: { readonly since: number; readonly waitSeconds: number },
): Promise<Result<PollResult>> {
  return env.ROOM.getByName(roomId).poll(token, input);
}

export async function listMembers(
  env: Env,
  roomId: string,
  token: string,
): Promise<Result<MembersResult>> {
  return env.ROOM.getByName(roomId).members(token);
}

export async function recordOutcome(
  env: Env,
  roomId: string,
  token: string,
  text: string,
): Promise<Result<{ outcome: Outcome }>> {
  return env.ROOM.getByName(roomId).setOutcome(token, text);
}

export async function leaveRoom(
  env: Env,
  roomId: string,
  token: string,
  memberId?: string,
): Promise<Result<null>> {
  return env.ROOM.getByName(roomId).leave(token, memberId);
}
