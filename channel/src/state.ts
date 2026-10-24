import fs from "node:fs/promises";
import path from "node:path";
import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH } from "./config.js";

/**
 * What the channel remembers between runs. The token is a room credential: it
 * is written with owner-only permissions and never logged or injected.
 */
export interface Membership {
  readonly roomId: string;
  readonly memberId: string;
  readonly name: string;
  readonly token: string;
  readonly cursor: number;
}

function assertRoomId(roomId: string): void {
  const valid =
    roomId.length === ROOM_ID_LENGTH && [...roomId].every((ch) => ROOM_ID_ALPHABET.includes(ch));
  if (!valid) throw new Error(`refusing to touch state for an invalid room id: ${roomId}`);
}

function fileFor(stateDir: string, roomId: string): string {
  assertRoomId(roomId);
  return path.join(stateDir, `${roomId}.json`);
}

function parseMembership(raw: string, roomId: string): Membership | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { memberId, name, token, cursor } = record;
  if (typeof memberId !== "string" || typeof name !== "string" || typeof token !== "string") {
    return null;
  }
  if (typeof cursor !== "number" || !Number.isFinite(cursor) || cursor < 0) return null;
  return { roomId, memberId, name, token, cursor };
}

/** Reads a saved membership. Missing, unreadable, or malformed files mean "no membership". */
export async function readMembership(stateDir: string, roomId: string): Promise<Membership | null> {
  const file = fileFor(stateDir, roomId);
  try {
    return parseMembership(await fs.readFile(file, "utf8"), roomId);
  } catch {
    return null;
  }
}

/** Writes a membership atomically with owner-only permissions. */
export async function writeMembership(stateDir: string, membership: Membership): Promise<void> {
  const file = fileFor(stateDir, membership.roomId);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify(membership, null, 2)}\n`;
  try {
    await fs.writeFile(temp, body, { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Returns a copy at a new cursor; the input is never mutated. */
export function withCursor(membership: Membership, cursor: number): Membership {
  return { ...membership, cursor };
}
