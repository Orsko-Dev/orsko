import { MAX_OBSERVERS_PER_ROOM, RECENT_MESSAGES_ON_JOIN } from "../config/constants";
import type { TierLimits } from "../config/tiers";
import { generateMemberId, generateToken, generateWebhookSecret, hashToken } from "../util/ids";
import { logEvent } from "../util/log";
import { fail, ok, type Result } from "../validation/errors";
import { webhookUrlProblem } from "../validation/webhook-url";
import type { IndexWriter } from "./index-writer";
import { memberStatus, type PresenceView } from "./presence";
import { consumeInvite, viewAccess } from "./privacy";
import type { MemberRow, RoomRow } from "./storage";
import * as db from "./storage";
import type { JoinResult, MemberRole, MembersResult } from "./types";

/**
 * What joining needs from a RoomObject instance. `announce` appends the
 * "<name> joined" system message; it is a callback because message append
 * lives on the class (it also reschedules the idle alarm). `index` mirrors
 * the new member into the account index in D1.
 */
export interface MembershipContext {
  readonly sql: SqlStorage;
  readonly index: IndexWriter;
  limits(row: RoomRow): TierLimits;
  announce(row: RoomRow, text: string, now: number): void;
}

/** Token lookup only: callers must have confirmed the room exists first. */
export async function findMember(sql: SqlStorage, token: string): Promise<Result<MemberRow>> {
  if (!token) return fail("invalid_token", "missing token");
  const member = db.findMemberByTokenHash(sql, await hashToken(token));
  if (!member || member.left_at !== null)
    return fail("invalid_token", "token is not valid for this room");
  return ok(member);
}

/**
 * Present members with their read state and status, plus the room's latest
 * seq. Members who left are omitted: the list answers "who is here now".
 * `view` carries the room's open sockets, which only the object can see.
 */
export function listPresence(sql: SqlStorage, row: RoomRow, view: PresenceView): MembersResult {
  return {
    members: db.listPresentMembers(sql, row.room_id).map((member) => ({
      ...member,
      connected: view.connected.has(member.memberId),
      status: memberStatus(member, view),
    })),
    lastSeq: row.next_seq - 1,
  };
}

function isFull(ctx: MembershipContext, row: RoomRow, role: MemberRole): boolean {
  return role === "agent"
    ? db.countActiveAgents(ctx.sql) >= ctx.limits(row).maxMembers
    : db.countPresentByRole(ctx.sql, "observer") >= MAX_OBSERVERS_PER_ROOM;
}

/** What a join input looks like once the Worker has resolved identity. */
export interface JoinInput {
  readonly name: string;
  readonly role: MemberRole;
  readonly webhookUrl?: string | undefined;
  /** The account the joining agent authenticated as, when it did. */
  readonly userId?: string | null;
  /** The raw invite token offered, for a private room. */
  readonly invite?: string | null;
}

/**
 * Everything that can refuse a join once the caller is known to be entitled
 * to enter the room at all: the name, the capacity, and the webhook target.
 */
function joinProblem(ctx: MembershipContext, row: RoomRow, input: JoinInput): Result<null> {
  if (db.findMemberByNameLower(ctx.sql, input.name.toLowerCase()))
    return fail("name_taken", `name "${input.name}" is in use`);
  if (isFull(ctx, row, input.role))
    return fail("room_full", `room has reached its ${input.role} limit`);
  if (input.webhookUrl === undefined) return ok(null);
  if (input.role !== "agent")
    return fail("invalid_request", "an observer cannot register a webhookUrl");
  // Checked at the Worker boundary too. Repeated here because the RPC is a
  // boundary of its own: nothing outside this object may decide what url the
  // room is willing to fetch.
  const problem = webhookUrlProblem(input.webhookUrl);
  return problem === null ? ok(null) : fail("invalid_request", problem);
}

async function newMemberRow(
  input: JoinInput,
  ids: { memberId: string; token: string; inviteId: string | null; secret: string | null },
  now: number,
): Promise<MemberRow> {
  return {
    member_id: ids.memberId,
    name: input.name,
    name_lower: input.name.toLowerCase(),
    role: input.role,
    token_hash: await hashToken(ids.token),
    joined_at: now,
    left_at: null,
    read_through: 0,
    delivered_through: 0,
    last_seen_at: now,
    webhook_url: input.webhookUrl ?? null,
    webhook_secret: ids.secret,
    webhook_status: ids.secret === null ? null : "active",
    user_id: input.userId ?? null,
    invite_id: ids.inviteId,
  };
}

/**
 * Everything a new member's arrival sets off outside the room's own member
 * table: the log line, the account index mirror, and the system message the
 * other agents see. The index write is best effort, after the room's own
 * write: see IndexWriter.
 */
function recordJoin(ctx: MembershipContext, row: RoomRow, member: MemberRow, now: number): void {
  logEvent("member.join", { roomId: row.room_id, memberId: member.member_id, role: member.role });
  void ctx.index.memberJoined({
    roomId: row.room_id,
    memberId: member.member_id,
    name: member.name,
    role: member.role,
    userId: member.user_id,
    inviteId: member.invite_id,
    joinedAt: member.joined_at,
    leftAt: null,
  });
  if (member.role === "agent") ctx.announce(row, `${member.name} joined`, now);
}

export async function joinRoom(
  ctx: MembershipContext,
  row: RoomRow,
  input: JoinInput,
  now: number,
): Promise<Result<JoinResult>> {
  if (row.state === "archived") return fail("room_archived", "room is archived");
  // The privacy gate runs before the name and capacity checks so a stranger
  // cannot learn which names are taken in a room they cannot enter. It only
  // peeks at the invite: the token is spent below, once the join is certain
  // to succeed, so a rejected name never burns a single-use invite.
  const access = await viewAccess(ctx.sql, row, input, now);
  if (!access.ok) return fail(access.code, access.message);
  const problem = joinProblem(ctx, row, input);
  if (!problem.ok) return fail(problem.code, problem.message);

  const memberId = generateMemberId();
  let inviteId: string | null = null;
  if (access.value === "invite") {
    const spent = consumeInvite(ctx.sql, await hashToken(input.invite ?? ""), now, memberId);
    if (spent.status === "invalid") return fail("invite_invalid", "that invite is no longer valid");
    inviteId = spent.inviteId;
  }
  const token = generateToken();
  // Returned once, in this response, and stored in plain form because every
  // delivery has to be signed with it.
  const secret = input.webhookUrl === undefined ? null : generateWebhookSecret();
  const member = await newMemberRow(input, { memberId, token, inviteId, secret }, now);
  db.insertMember(ctx.sql, member);
  recordJoin(ctx, row, member, now);
  const recent = db.listRecentMessages(ctx.sql, row.room_id, RECENT_MESSAGES_ON_JOIN);
  const nextSince = recent.length > 0 ? (recent.at(-1)?.seq ?? 0) : 0;
  // The join hands these over in `recent`: they are delivered, not unread.
  db.advanceDeliveredThrough(ctx.sql, member.member_id, nextSince);
  const base = {
    memberId: member.member_id,
    ...(inviteId === null ? {} : { inviteId }),
    name: member.name,
    role: member.role,
    token,
    recent,
    nextSince,
  };
  if (input.webhookUrl === undefined || secret === null) return ok(base);
  return ok({ ...base, webhook: { url: input.webhookUrl, secret } });
}
