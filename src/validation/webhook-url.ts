import { MAX_WEBHOOK_URL_CHARS } from "../config/constants";

/**
 * Hosts for which plain `http` is accepted and the IP-literal rule is
 * waived, so a developer can point a room at a webhook receiver running on
 * their own machine. Nothing else may be an IP literal: the room fetches the
 * url from inside our network, and a literal is how an attacker would aim
 * that fetch at a metadata service or an internal host (SSRF).
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * An IPv4 address carried inside a hostname's labels, which is how the
 * wildcard DNS services (`10.0.0.1.nip.io`, `169-254-169-254.sslip.io`)
 * resolve a name straight back to that address. Rejecting the shape is a
 * heuristic, not a proof: see the note below on what actually protects us.
 */
const EMBEDDED_IPV4 = /\d{1,3}([.-]\d{1,3}){3}/;

/** Suffixes that only ever name something inside a private network. */
const INTERNAL_SUFFIXES: readonly string[] = [".internal", ".local", ".localhost", ".arpa"];

/** Named outright because it is the best known cloud-metadata endpoint. */
const DENIED_HOSTS: ReadonlySet<string> = new Set(["metadata.google.internal"]);

/** WHATWG URL keeps the brackets on an IPv6 host, which makes this exact. */
function isIpLiteral(hostname: string): boolean {
  return IPV4.test(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"));
}

/**
 * Hostnames that resolve inside a network rather than on the internet: an
 * internal-only suffix, a bare single label (an intranet short name), or a
 * host we deny by name.
 */
function isInternalName(host: string): boolean {
  // A trailing dot names the same host, so it must not slip past a suffix.
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;
  if (DENIED_HOSTS.has(hostname)) return true;
  if (INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  return !hostname.includes(".");
}

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Why `url` may not be used as a webhook target, or null when it may.
 * Returning the reason (rather than a boolean) lets the API tell a caller
 * which rule their url broke.
 *
 * These rules are a denylist over the text of the url, so they are a first
 * filter and not the control: a hostname that resolves to a private address,
 * or that resolves differently on the second lookup (DNS rebinding), passes
 * them. Egress-level protection is what actually contains an SSRF here.
 */
export function webhookUrlProblem(url: string): string | null {
  if (url.length > MAX_WEBHOOK_URL_CHARS) {
    return `webhookUrl must be at most ${MAX_WEBHOOK_URL_CHARS} characters`;
  }
  const parsed = parse(url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    if (!parsed) return "webhookUrl must be an absolute http(s) url";
    return "webhookUrl must use https";
  }
  if (parsed.hostname === "") return "webhookUrl must be an absolute http(s) url";
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol === "http:" && !local) return "webhookUrl must use https";
  if (parsed.username !== "" || parsed.password !== "") {
    return "webhookUrl must not contain credentials";
  }
  if (local) return null;
  if (isIpLiteral(parsed.hostname) || EMBEDDED_IPV4.test(parsed.hostname)) {
    return "webhookUrl must not point at an ip address";
  }
  if (isInternalName(parsed.hostname)) {
    return "webhookUrl must not point at an internal hostname";
  }
  return null;
}

export function isAllowedWebhookUrl(url: string): boolean {
  return webhookUrlProblem(url) === null;
}
