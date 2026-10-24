import type { Tier } from "../config/tiers";

export type RoomState = "live" | "slow" | "archived";
export type MemberRole = "agent" | "observer";
export type PollMode = "live" | "slow" | "archived";
/** `active` once a webhook is registered, `failed` after it is disabled. */
export type WebhookStatus = "active" | "failed" | null;

/** `active` while a member holds a socket or was seen in the last ten minutes, else `away`. */
export type MemberStatus = "active" | "away";

export interface Member {
  readonly memberId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly joinedAt: string;
  readonly leftAt: string | null;
  /** Highest `since` cursor the member has ever sent to the poll endpoint. */
  readonly readThrough: number;
  /** Time of the member's last authenticated request, or null. */
  readonly lastSeenAt: string | null;
  /** Whether this member has a working webhook. The url is never returned. */
  readonly webhookStatus: WebhookStatus;
  /** 16-hex-char seed for this member's deterministic avatar in this room. */
  readonly avatarSeed: string;
  /**
   * Whether this member joined while authenticated as an account. Only the
   * fact is exposed, never which account: see {@link PublicMember}.
   */
  readonly linked: boolean;
}

/**
 * A member as the unauthenticated room metadata shows them. Webhook state
 * and account linkage are kept out of that view: whether a member is
 * reachable, and whether they are signed in, are the room's own business, so
 * they are only served to a member holding a token.
 */
export type PublicMember = Omit<Member, "webhookStatus" | "linked"> & {
  /** Derived at read time from open sockets and `lastSeenAt`; see presence.ts. */
  readonly status: MemberStatus;
};

/**
 * A present member as the room reports them, with live socket presence.
 * `connected` is computed from the room's open stream sockets, so it is only
 * meaningful for members who are still here.
 */
export interface PresentMember extends Member {
  /** True while this member holds at least one open stream socket. */
  readonly connected: boolean;
  /** Derived at read time from open sockets and `lastSeenAt`; see presence.ts. */
  readonly status: MemberStatus;
}

export interface MembersResult {
  readonly members: readonly PresentMember[];
  /** The room's latest message seq, so a caller can see who is behind. */
  readonly lastSeq: number;
}

export interface Message {
  readonly id: string;
  readonly seq: number;
  readonly roomId: string;
  readonly from: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly createdAt: string;
}

export interface Attachment {
  readonly attachmentId: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

/** The outcome an agent recorded for the room; the latest write wins. */
export interface Outcome {
  readonly text: string;
  /** The name of the agent who recorded it. */
  readonly by: string;
  readonly at: string;
}

export interface RoomMeta {
  readonly roomId: string;
  readonly tier: Tier;
  readonly state: RoomState;
  readonly purpose: string | null;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly messageCount: number;
  readonly attachmentCount: number;
  readonly members: readonly PublicMember[];
  /** Whether joining requires an invite. Enforced starting with Task 6. */
  readonly private: boolean;
  /** What the session decided and left open, once an agent has recorded it. */
  readonly outcome: Outcome | null;
}

/** Everything the markdown export needs: every member ever present, every message. */
export interface TranscriptExport {
  readonly meta: RoomMeta;
  readonly messages: readonly Message[];
}

export interface JoinResult {
  readonly memberId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly token: string;
  /**
   * The last up-to-`RECENT_MESSAGES_ON_JOIN` messages in the room, in
   * ascending seq order. When the joiner is an agent this includes the
   * "<name> joined" system message just recorded for them.
   */
  readonly recent: readonly Message[];
  /** The seq of the last message in `recent`, or 0 when the room is empty. */
  readonly nextSince: number;
  /**
   * The invite this join spent, when one admitted it. The Worker marks that
   * invite used in D1; it is not a secret and never the token itself.
   */
  readonly inviteId?: string;
  /**
   * Present only when the join registered a webhook. The secret is returned
   * here and nowhere else.
   */
  readonly webhook?: { readonly url: string; readonly secret: string };
}

/** A post as its author gets it back: the message, and what the author had not read. */
export interface PostedMessage {
  readonly message: Message;
  /** Messages by other members after the author's cursors, counted before this post. */
  readonly unread: number;
}

/** The `POST /messages` response body: the message's own fields plus `unread`. */
export type MessageWithUnread = Message & { readonly unread: number };

export interface PollResult {
  readonly messages: readonly Message[];
  readonly nextSince: number;
  readonly mode: PollMode;
  readonly retryAfterSeconds?: number;
}
