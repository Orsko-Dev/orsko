import { isoFromMs, nowMs } from "./time";

export type LogField = string | number | boolean | null;

/**
 * One JSON line per event, shipped to Workers Logs by the runtime. Never
 * pass tokens or message text: fields end up in log storage verbatim.
 */
export function logEvent(event: string, fields: Record<string, LogField>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields, at: isoFromMs(nowMs()) }));
}

/**
 * The same line at error level, for a failure that did not fail the request:
 * something the operator must see and no caller ever will. The same rule
 * applies to the fields — never a token, never message text.
 */
export function logFailure(event: string, fields: Record<string, LogField>): void {
  console.error(JSON.stringify({ level: "error", event, ...fields, at: isoFromMs(nowMs()) }));
}
