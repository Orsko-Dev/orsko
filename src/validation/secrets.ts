/**
 * Shape-based credential detection for message text.
 *
 * Detection is deliberately about shape, not vocabulary: ordinary prose and
 * code that merely talks about passwords must pass. Only the last rule
 * (`password_assignment`) is a heuristic, and it is narrowed by a value check
 * so that `password: string` or `token = bearerToken(c)` are not flagged.
 *
 * Nothing here ever returns the matched text: callers report kinds only, so a
 * rejected secret is never echoed into a response or a log line.
 */

export interface SecretHit {
  readonly kind: string;
  readonly label: string;
}

interface SecretRule {
  readonly kind: string;
  readonly label: string;
  readonly pattern: RegExp;
  /** Optional narrowing on the first capture group, for heuristic rules. */
  readonly accept?: (value: string) => boolean;
  /**
   * Kinds that describe the same text more precisely. A hit is dropped when
   * every one of its matches sits inside a match of one of these kinds, so an
   * Anthropic key is reported once, as `anthropic_key`.
   */
  readonly subsumedBy?: readonly string[];
}

/** Substrings that only ever appear in documentation stand-ins. */
const PLACEHOLDER_MARKERS: readonly string[] = [
  "xxx",
  "***",
  "your-",
  "your_",
  "example",
  "changeme",
  "redacted",
];

/** Values that are the bare name of the thing rather than its value. */
const PLACEHOLDER_WORDS: readonly string[] = ["password", "passwd", "pwd", "secret", "token"];

/**
 * A shell-style variable name: the conventional `UPPER_SNAKE_CASE` used for
 * environment variables. Restricting to uppercase keeps a mixed-case value
 * like `$ecretPassw0rd99` — a real password that merely starts with `$` —
 * from being mistaken for a variable reference.
 */
const SHELL_VAR_NAME = "[A-Z_][A-Z0-9_]*";

/**
 * `<value>`, `{value}`, `${VALUE}`, `%(value)s`, `$VALUE`, and `$(VALUE)`.
 * The last two require the whole value to be a shell-style variable
 * reference, not merely to start with `$`.
 */
const PLACEHOLDER_SHAPES: readonly RegExp[] = [
  /^<[^>]*>$/,
  /^\$?\{[^}]*\}$/,
  /^%\([^)]*\)s$/,
  new RegExp(`^\\$${SHELL_VAR_NAME}$`),
  new RegExp(`^\\$\\(${SHELL_VAR_NAME}\\)$`),
];

/**
 * True when the value is a stand-in rather than a credential: a template
 * placeholder, a documentation marker, or the bare name of the field. The
 * word list matches whole values only, so `secret99` still counts as a
 * credential.
 */
function isPlaceholderValue(value: string): boolean {
  if (PLACEHOLDER_SHAPES.some((shape) => shape.test(value))) return true;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_WORDS.includes(lower)) return true;
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * A heuristic assignment counts only when the value looks like an actual
 * credential: mixed letters and digits, and not one of the placeholder shapes
 * that documentation and type signatures use.
 */
function looksLikeCredentialValue(value: string): boolean {
  if (isPlaceholderValue(value)) return false;
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/**
 * A connection string carries a real password unless the password segment is
 * a placeholder. Unlike an assignment, the URL shape is specific enough on
 * its own, so no letters-and-digits check applies.
 */
function isRealConnectionPassword(value: string): boolean {
  return !isPlaceholderValue(value);
}

const RULES: readonly SecretRule[] = [
  {
    kind: "aws_access_key",
    label: "an AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    kind: "github_token",
    label: "a GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  {
    kind: "slack_token",
    label: "a Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    kind: "anthropic_key",
    label: "an Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  },
  {
    kind: "openai_key",
    label: "an OpenAI API key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
    // An `sk-ant-` key also fits this shape; the Anthropic rule is the
    // precise one, so a key matched by both is reported only as Anthropic.
    subsumedBy: ["anthropic_key"],
  },
  {
    kind: "google_api_key",
    label: "a Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    kind: "stripe_key",
    label: "a Stripe secret key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  {
    kind: "private_key_block",
    label: "a private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    kind: "jwt",
    label: "a signed token (JWT)",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: "connection_string_password",
    label: "a database password in a connection string",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s@]{4,})@[^\s]+/,
    accept: isRealConnectionPassword,
  },
  {
    kind: "password_assignment",
    label: "a password or key assigned in code or config",
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?([^\s"']{8,})/i,
    accept: looksLikeCredentialValue,
  },
];

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Every span in `text` the rule matches and accepts. A heuristic rule may
 * match several times in one message; a placeholder early in the text must
 * not hide a real credential later in it.
 */
function matchSpans(rule: SecretRule, text: string): Span[] {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const scan = new RegExp(rule.pattern.source, flags);
  const spans: Span[] = [];
  for (const found of text.matchAll(scan)) {
    const value = found[1];
    if (rule.accept && !(value !== undefined && rule.accept(value))) continue;
    spans.push({ start: found.index, end: found.index + found[0].length });
  }
  return spans;
}

function isInside(span: Span, outer: Span): boolean {
  return span.start >= outer.start && span.end <= outer.end;
}

/**
 * True when a more precise kind already covers every match of this one, so
 * reporting both would name the same text twice.
 */
function isSubsumed(rule: SecretRule, spans: Span[], byKind: ReadonlyMap<string, Span[]>): boolean {
  const covering = (rule.subsumedBy ?? []).flatMap((kind) => byKind.get(kind) ?? []);
  if (covering.length === 0) return false;
  return spans.every((span) => covering.some((outer) => isInside(span, outer)));
}

/**
 * Every kind of credential shape present in `text`, deduplicated by kind and
 * in rule order. An empty array means the text is clear.
 */
export function detectSecrets(text: string): readonly SecretHit[] {
  if (text.length === 0) return [];
  const spansByKind = new Map<string, Span[]>();
  for (const rule of RULES) {
    const spans = matchSpans(rule, text);
    if (spans.length > 0) spansByKind.set(rule.kind, spans);
  }
  return RULES.filter((rule) => {
    const spans = spansByKind.get(rule.kind);
    return spans !== undefined && !isSubsumed(rule, spans, spansByKind);
  }).map((rule) => ({ kind: rule.kind, label: rule.label }));
}

/** An actionable rejection message that names the kinds but never the value. */
export function secretRejectionMessage(hits: readonly SecretHit[]): string {
  const labels = hits.map((hit) => hit.label).join(", ");
  return `message contains what looks like ${labels}; redact it and post again`;
}
