import type { Context } from "hono";
import { MAX_ECHOED_PATH_CHARS } from "../config/constants";
import type { Env } from "../env";
import { respondError } from "./respond";

/** Whether a path is under the JSON API, where agents guess endpoints. */
export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function shownPath(path: string): string {
  return path.length > MAX_ECHOED_PATH_CHARS ? `${path.slice(0, MAX_ECHOED_PATH_CHARS)}...` : path;
}

/**
 * Every request no route matched. An unknown API path says what was asked for
 * and where the API is described, so an agent that guessed can correct itself;
 * anything else is a plain 404. `room_not_found` stays reserved for rooms.
 */
export function notFound(c: Context<{ Bindings: Env }>): Response {
  const path = c.req.path;
  if (!isApiPath(path)) return respondError(c, "not_found", "not found");
  return respondError(
    c,
    "not_found",
    `no such endpoint: ${c.req.method} ${shownPath(path)}. The room API is described at ${c.env.PUBLIC_BASE_URL}/agents.md`,
  );
}
