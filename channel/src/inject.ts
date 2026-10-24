/**
 * The one place a room message becomes a session event. Both transports (the
 * stream and the long-poll fallback) call it, so the cursor, the "never inject
 * my own messages" rule, and the resend bookkeeping have a single
 * implementation and a single piece of state, no matter which transport is
 * live at the time.
 */

import type { Message } from "./client.js";
import { RESEND_AFTER_MS } from "./config.js";
import type { Logger } from "./log.js";
import { type PendingTracker, prependResend } from "./pending.js";

export interface ChannelEvent {
  readonly content: string;
  readonly meta: Readonly<Record<string, string>>;
}

export interface InjectorDeps {
  readonly roomId: string;
  /** The channel's own member name; its messages are never injected. */
  readonly selfName: string;
  readonly cursor: number;
  readonly emit: (event: ChannelEvent) => Promise<void>;
  readonly saveCursor: (cursor: number) => Promise<void>;
  readonly now: () => number;
  readonly pending: PendingTracker;
  readonly log: Logger;
}

export interface Injector {
  /** How far the channel has read. Advances only through `deliver`. */
  cursor(): number;
  /**
   * Injects the messages that are new and not the channel's own, then moves
   * the cursor to `nextSince`. Returns the seqs it injected. Calls are
   * serialised, so a stream frame and a poll result cannot interleave.
   */
  deliver(messages: readonly Message[], nextSince: number): Promise<ReadonlySet<number>>;
  /** Emits a terminal event (archived, stopped) with the pending backlog. */
  finish(event: string, content: string, excludeSeqs?: ReadonlySet<number>): Promise<void>;
}

function contentFor(message: Message): string {
  const attachments = message.attachmentIds;
  if (attachments.length === 0) return message.text;
  return `${message.text}\nattachments: ${attachments.join(", ")}`;
}

export function createInjector(deps: InjectorDeps): Injector {
  let cursor = deps.cursor;
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs `task` after every earlier one, whatever those did. */
  function serialise<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function inject(message: Message): Promise<void> {
    const now = deps.now();
    const raw = contentFor(message);
    const resend = deps.pending.resendLines(now, RESEND_AFTER_MS);
    if (resend.length > 0) deps.pending.acknowledge();
    const kind = message.from === "system" ? "system" : "message";
    await deps.emit({
      content: prependResend(raw, resend),
      meta: { room: deps.roomId, from: message.from, seq: String(message.seq), kind },
    });
    deps.pending.remember([{ seq: message.seq, from: message.from, content: raw, at: now }]);
    deps.log.event("channel.injected", { seq: message.seq, kind, resent: resend.length });
  }

  async function deliverNow(
    messages: readonly Message[],
    nextSince: number,
  ): Promise<ReadonlySet<number>> {
    const injected = new Set<number>();
    for (const message of messages) {
      if (message.seq <= cursor) continue;
      if (message.from === deps.selfName) {
        deps.log.event("channel.skipped_own", { seq: message.seq });
        continue;
      }
      await inject(message);
      injected.add(message.seq);
    }
    if (nextSince > cursor) {
      cursor = nextSince;
      await deps.saveCursor(cursor);
    }
    return injected;
  }

  async function finishNow(
    event: string,
    content: string,
    excludeSeqs: ReadonlySet<number>,
  ): Promise<void> {
    const resend = deps.pending.resendLines(deps.now(), 0, excludeSeqs);
    if (resend.length > 0) deps.pending.acknowledge();
    await deps.emit({
      content: prependResend(content, resend),
      meta: { room: deps.roomId, event },
    });
    deps.log.event(`channel.${event}`, { seq: cursor, resent: resend.length });
  }

  return {
    cursor: () => cursor,
    deliver: (messages, nextSince) => serialise(() => deliverNow(messages, nextSince)),
    finish: (event, content, excludeSeqs = new Set()) =>
      serialise(() => finishNow(event, content, excludeSeqs)),
  };
}
