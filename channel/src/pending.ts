/**
 * Resend bookkeeping. Injected events are not acknowledged by Claude Code, so
 * the channel keeps the seqs it has injected until a channel tool is called
 * (evidence that Claude is awake and has seen them). If a new event is injected
 * while older unacknowledged seqs are still pending, their summaries ride along
 * once, which bounds duplicates to a single resend per message.
 */

const MAX_RESENT_CHARS = 200;

export interface PendingEntry {
  readonly seq: number;
  readonly from: string;
  readonly content: string;
  /** Milliseconds from the injected clock, so tests can drive it. */
  readonly at: number;
}

export interface PendingState {
  readonly entries: readonly PendingEntry[];
}

export const EMPTY_PENDING: PendingState = { entries: [] };

export function remember(state: PendingState, entries: readonly PendingEntry[]): PendingState {
  if (entries.length === 0) return state;
  return { entries: [...state.entries, ...entries] };
}

export function acknowledge(_state: PendingState): PendingState {
  return EMPTY_PENDING;
}

function truncate(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= MAX_RESENT_CHARS ? flat : `${flat.slice(0, MAX_RESENT_CHARS)}…`;
}

/**
 * Lines for entries that have been pending longer than `afterMs`, excluding
 * any seqs in `excludeSeqs` (e.g. messages injected earlier in the same
 * step, which are already visible in the event they'd otherwise be
 * re-attached to).
 */
export function resendLines(
  state: PendingState,
  now: number,
  afterMs: number,
  excludeSeqs?: ReadonlySet<number>,
): readonly string[] {
  return state.entries
    .filter((entry) => now - entry.at >= afterMs)
    .filter((entry) => !excludeSeqs?.has(entry.seq))
    .map(
      (entry) =>
        `[resent, not yet acknowledged] ${entry.from} (seq ${entry.seq}): ${truncate(entry.content)}`,
    );
}

export function prependResend(content: string, lines: readonly string[]): string {
  return lines.length === 0 ? content : `${lines.join("\n")}\n${content}`;
}

/**
 * The one piece of shared mutable state in the channel: the poller adds to it
 * and the tools clear it. Every transition goes through the pure helpers above.
 */
export class PendingTracker {
  private state: PendingState = EMPTY_PENDING;

  get size(): number {
    return this.state.entries.length;
  }

  remember(entries: readonly PendingEntry[]): void {
    this.state = remember(this.state, entries);
  }

  /** Called when Claude proves it is awake by using a channel tool. */
  acknowledge(): void {
    this.state = acknowledge(this.state);
  }

  resendLines(now: number, afterMs: number, excludeSeqs?: ReadonlySet<number>): readonly string[] {
    return resendLines(this.state, now, afterMs, excludeSeqs);
  }
}
