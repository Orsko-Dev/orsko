import { logFailure } from "../util/log";

/**
 * Runs an account-index write that happens *after* the room object has
 * already been changed. The room is the authority on membership and on
 * invites; D1 only mirrors it so the owner's lists and history can be built.
 * Letting a D1 outage turn an admitted member or a minted invite into a 500
 * would lose the caller their token for good, so a failure here is logged and
 * swallowed: the caller keeps its success response, and the mirror is behind
 * until it is repaired.
 */
export async function mirrorIndexWrite(
  op: string,
  roomId: string,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    // Never the token, and never the message either: a D1 error text can
    // quote the row it choked on. Only the class of failure, what the write
    // was, and which room it belonged to.
    logFailure("index.write_failed", {
      op,
      roomId,
      errorClass: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
