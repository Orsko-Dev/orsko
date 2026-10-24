import type { Context } from "hono";
import { Hono } from "hono";
import * as adb from "../../account/db";
import { resolveIdentity, sameOriginRequest } from "../../account/identity";
import { keyHash, mintKey } from "../../account/keys";
import { type HistoryFilter, listRoomsForUser } from "../../account/room-index";
import {
  KEY_MINT_LIMIT_PER_HOUR,
  KEY_MINT_WINDOW_SECONDS,
  MAX_ACTIVE_API_KEYS,
} from "../../config/constants";
import type { Env } from "../../env";
import { generateShortId } from "../../util/ids";
import { nowMs } from "../../util/time";
import { errorBody } from "../../validation/errors";
import { ApiKeyIdParam, CreateApiKeyBody } from "../../validation/schemas";
import { readJsonBody } from "../body";
import { respondError } from "../respond";

export const meKeys = new Hono<{ Bindings: Env }>();

/** The outcome of {@link requireSession}: either the caller's userId, or an
 * already-built 401 response for the route handler to return as-is. */
type SessionCheck =
  | { userId: string; response?: undefined }
  | { userId?: undefined; response: Response };

/**
 * Resolves identity and requires it to come from an interactive browser
 * session, never from an `X-Orsko-Key`. The API-keys routes manage the keys
 * themselves, so a leaked key must not be usable to mint more keys or revoke
 * the account's existing ones — only a signed-in session may do that.
 *
 * Returns `{ userId }` on success, or `{ response }` holding a 401
 * `unauthorized` response when the caller is unauthenticated or the request
 * was authenticated with an API key instead of a browser session.
 */
async function requireSession(c: Context<{ Bindings: Env }>): Promise<SessionCheck> {
  const identity = await resolveIdentity(c);
  if (!identity) {
    return { response: respondError(c, "unauthorized", "sign in required") };
  }
  if (identity.via !== "session") {
    return {
      response: respondError(c, "unauthorized", "sign in with your browser to manage keys"),
    };
  }
  return { userId: identity.userId };
}

meKeys.get("/", async (c) => {
  const session = await requireSession(c);
  if (session.response) return session.response;
  const rows = await adb.listApiKeys(c.env.DB, session.userId);
  return c.json({
    keys: rows.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      label: k.label,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    })),
  });
});

meKeys.post("/", async (c) => {
  const session = await requireSession(c);
  if (session.response) return session.response;
  if (!sameOriginRequest(c)) return respondError(c, "forbidden", "cross-site request");
  const body = await readJsonBody(c);
  if (!body.ok) return respondError(c, body.code, body.message);
  const parsed = CreateApiKeyBody.safeParse(body.value);
  if (!parsed.success) return respondError(c, "invalid_request", "a label is required");

  // The active-key cap is checked before the mint-rate limiter so that
  // repeatedly hitting the cap never consumes the user's hourly mint budget.
  const active = await adb.countActiveApiKeys(c.env.DB, session.userId);
  // 409, not the usual 400 for `invalid_request`: the request is well formed
  // but conflicts with existing state, and no new error code is warranted
  // for one caller-visible case.
  if (active >= MAX_ACTIVE_API_KEYS)
    return c.json(
      errorBody("invalid_request", `you already have ${MAX_ACTIVE_API_KEYS} active keys`),
      409,
    );

  const limiter = c.env.IP_LIMITER.getByName(`keys:${session.userId}`);
  const gate = await limiter.hit({
    limit: KEY_MINT_LIMIT_PER_HOUR,
    windowSeconds: KEY_MINT_WINDOW_SECONDS,
  });
  if (!gate.allowed)
    return respondError(c, "rate_limited", "too many keys minted", gate.retryAfterSeconds);

  const { raw, prefix } = mintKey();
  const id = `key_${generateShortId()}`;
  await adb.insertApiKey(c.env.DB, {
    id,
    userId: session.userId,
    keyHash: await keyHash(raw),
    prefix,
    label: parsed.data.label,
    now: nowMs(),
  });
  return c.json({ id, key: raw, prefix, label: parsed.data.label }, 201);
});

meKeys.delete("/:id", async (c) => {
  const session = await requireSession(c);
  if (session.response) return session.response;
  if (!sameOriginRequest(c)) return respondError(c, "forbidden", "cross-site request");
  const id = ApiKeyIdParam.safeParse(c.req.param("id"));
  if (!id.success) return respondError(c, "invalid_request", "invalid key id");
  const revoked = await adb.revokeApiKey(c.env.DB, session.userId, id.data, nowMs());
  if (!revoked) return respondError(c, "invalid_request", "no such active key");
  return c.body(null, 204);
});

export const meRooms = new Hono<{ Bindings: Env }>();

/** The history filters the endpoint accepts; anything else is `all`. */
function historyFilter(raw: string | undefined): HistoryFilter {
  return raw === "created" || raw === "joined" ? raw : "all";
}

/**
 * The signed-in user's room history: rooms they created and rooms an agent
 * of theirs joined, newest activity first. A personal API key is accepted as
 * well as a session, so an agent can list its own account's rooms.
 */
meRooms.get("/", async (c) => {
  const identity = await resolveIdentity(c);
  if (!identity) return respondError(c, "unauthorized", "sign in required");
  const page = await listRoomsForUser(
    c.env.DB,
    identity.userId,
    historyFilter(c.req.query("filter")),
    c.req.query("cursor") ?? null,
    c.env.PUBLIC_BASE_URL,
  );
  return c.json(page);
});
