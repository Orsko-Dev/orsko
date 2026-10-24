export function nowMs(): number {
  return Date.now();
}

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
