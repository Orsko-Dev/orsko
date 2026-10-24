/**
 * The Orsko stream protocol: one JSON object per WebSocket text frame, each
 * with a `type`. Server frames arrive from an untrusted network, so every one
 * is validated here and anything malformed is rejected rather than narrowed by
 * assertion.
 */

import type { Member, Message } from "./client.js";

export type StreamState = "live" | "slow" | "archived";

const STREAM_STATES: readonly string[] = ["live", "slow", "archived"];

/** A member as the stream reports it: the HTTP shape plus socket presence. */
export interface StreamMember extends Member {
  readonly connected?: boolean;
}

export interface WelcomeFrame {
  readonly type: "welcome";
  readonly roomId: string;
  readonly you: { readonly memberId: string; readonly name: string; readonly role: string };
  readonly members: readonly StreamMember[];
  readonly lastSeq: number;
  readonly state: StreamState;
}

export interface MessageFrame {
  readonly type: "message";
  readonly message: Message;
}

export interface PresenceFrame {
  readonly type: "presence";
  readonly members: readonly StreamMember[];
}

export interface StateFrame {
  readonly type: "state";
  readonly state: StreamState;
}

export interface AckFrame {
  readonly type: "ack";
  readonly id: string;
  readonly seq: number;
  readonly message: Message;
  readonly unread?: number;
}

export interface ErrorFrame {
  readonly type: "error";
  readonly id?: string;
  readonly code: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export type ServerFrame =
  | WelcomeFrame
  | MessageFrame
  | PresenceFrame
  | StateFrame
  | AckFrame
  | ErrorFrame;

/* ---------------------------------------------------------------- client -> */

export function helloFrame(token: string, since: number): string {
  return JSON.stringify({ type: "hello", token, since });
}

export function postFrame(id: string, text: string, attachmentIds?: readonly string[]): string {
  return JSON.stringify({
    type: "post",
    id,
    text,
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
  });
}

export function readFrame(since: number): string {
  return JSON.stringify({ type: "read", since });
}

/* ---------------------------------------------------------------- server -> */

type Record_ = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Record_ | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record_;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMessage(value: unknown): Message | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = str(record.id);
  const seq = num(record.seq);
  const roomId = str(record.roomId);
  const from = str(record.from);
  const text = str(record.text);
  const createdAt = str(record.createdAt);
  if (id === null || seq === null || roomId === null) return null;
  if (from === null || text === null || createdAt === null) return null;
  const raw = record.attachmentIds;
  const attachmentIds =
    Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
      ? (raw as readonly string[])
      : [];
  return { id, seq, roomId, from, text, attachmentIds, createdAt };
}

function parseMember(value: unknown): StreamMember | null {
  const record = asRecord(value);
  if (!record) return null;
  const memberId = str(record.memberId);
  const name = str(record.name);
  const role = str(record.role);
  if (memberId === null || name === null || role === null) return null;
  return {
    memberId,
    name,
    role,
    readThrough: num(record.readThrough) ?? 0,
    lastSeenAt: str(record.lastSeenAt),
    ...(typeof record.joinedAt === "string" ? { joinedAt: record.joinedAt } : {}),
    ...(record.leftAt === null || typeof record.leftAt === "string"
      ? { leftAt: record.leftAt as string | null }
      : {}),
    ...(typeof record.connected === "boolean" ? { connected: record.connected } : {}),
  };
}

function parseMembers(value: unknown): readonly StreamMember[] | null {
  if (!Array.isArray(value)) return null;
  const members: StreamMember[] = [];
  for (const entry of value) {
    const member = parseMember(entry);
    if (!member) return null;
    members.push(member);
  }
  return members;
}

function parseState(value: unknown): StreamState | null {
  const state = str(value);
  return state !== null && STREAM_STATES.includes(state) ? (state as StreamState) : null;
}

function parseWelcome(record: Record_): WelcomeFrame | null {
  const roomId = str(record.roomId);
  const you = asRecord(record.you);
  const members = parseMembers(record.members);
  const lastSeq = num(record.lastSeq);
  const state = parseState(record.state);
  if (roomId === null || !you || !members || lastSeq === null || state === null) return null;
  const memberId = str(you.memberId);
  const name = str(you.name);
  const role = str(you.role);
  if (memberId === null || name === null || role === null) return null;
  return { type: "welcome", roomId, you: { memberId, name, role }, members, lastSeq, state };
}

function parseAck(record: Record_): AckFrame | null {
  const id = str(record.id);
  const seq = num(record.seq);
  const message = parseMessage(record.message);
  if (id === null || seq === null || !message) return null;
  const unread = num(record.unread);
  return { type: "ack", id, seq, message, ...(unread === null ? {} : { unread }) };
}

function parseError(record: Record_): ErrorFrame | null {
  const code = str(record.code);
  if (code === null) return null;
  const id = str(record.id);
  const retryAfterSeconds = num(record.retryAfterSeconds);
  return {
    type: "error",
    code,
    message: str(record.message) ?? code,
    ...(id === null ? {} : { id }),
    ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
  };
}

function decode(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
  return null;
}

/** Parses one server frame. Returns null for anything unknown or malformed. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const text = decode(raw);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  switch (record.type) {
    case "welcome":
      return parseWelcome(record);
    case "message": {
      const message = parseMessage(record.message);
      return message ? { type: "message", message } : null;
    }
    case "presence": {
      const members = parseMembers(record.members);
      return members ? { type: "presence", members } : null;
    }
    case "state": {
      const state = parseState(record.state);
      return state ? { type: "state", state } : null;
    }
    case "ack":
      return parseAck(record);
    case "error":
      return parseError(record);
    default:
      return null;
  }
}
