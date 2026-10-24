import type { Context } from "hono";
import { Hono } from "hono";
import { resolveIdentity } from "../../account/identity";
import { trackerFor } from "../../analytics/track";
import { OBSERVER_NAME_PREFIX } from "../../config/constants";
import type { Env } from "../../env";
import type { ViewAccess } from "../../room/privacy";
import type { RoomObject } from "../../room/RoomObject";
import { joinRoom } from "../../rooms/actions";
import { pasteSentenceFor, renderAgentInstructions } from "../../templates/agents";
import { generateShortId } from "../../util/ids";
import { logFailure } from "../../util/log";
import { RoomIdParam } from "../../validation/schemas";
import { bearerToken } from "../auth";
import { negotiate, parseFormat, type Representation } from "../negotiate";
import { respondError } from "../respond";
import { fillConnectPage, fillRoomPage } from "../room-html";

/**
 * The pages the Worker serves itself: the room link in every representation,
 * the brand guidelines and the sample instructions.
 */
export const roomPage = new Hono<{ Bindings: Env }>();

/**
 * What `#paste` shows on a private room's page instead of a sentence nobody
 * could join with. Kept word for word in step with renderJoinHint in
 * public/app.js, which shows the same text once the room details load.
 */
export const OWNER_PASTE_HINT =
  "Create an invite below. Each invite carries its own sentence to paste.";
export const GUEST_PASTE_HINT = "Ask the room owner for an invite.";

/** One of the bundled assets, or null (logged) when the asset binding fails. */
async function fetchAsset(c: Context<{ Bindings: Env }>, path: string): Promise<Response | null> {
  const asset = await c.env.ASSETS.fetch(new URL(path, c.req.url));
  if (asset.ok) return asset;
  logFailure("page.asset_failed", { route: c.req.path, path, status: asset.status });
  return null;
}

/** One of the bundled pages, served as the response to this request. */
async function servePage(
  c: Context<{ Bindings: Env }>,
  path: string,
  status: 200 | 403,
): Promise<Response> {
  const asset = await fetchAsset(c, path);
  if (!asset) return respondError(c, "internal", "room view unavailable");
  return new Response(asset.body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// The brand guidelines, served from the same bundled assets as the room page.
roomPage.get("/brand", (c) => servePage(c, "/brand.html", 200));

// The connector setup page: the connector URL is filled in from
// PUBLIC_BASE_URL rather than shipped as a hardcoded host in the asset.
roomPage.get("/connect", async (c) => {
  const asset = await fetchAsset(c, "/connect.html");
  if (!asset) return respondError(c, "internal", "room view unavailable");
  return fillConnectPage(asset, `${c.env.PUBLIC_BASE_URL}/mcp`);
});

// Workers Assets would otherwise serve the raw, unfilled asset directly for
// this exact path (run_worker_first in wrangler.jsonc only forces the Worker
// to run for it; it does not stop /connect.html from also naming the file).
// Redirect it to the filled page instead of ever showing the placeholder.
roomPage.get("/connect.html", (c) => c.redirect("/connect", 301));

roomPage.get("/agents.md", (c) =>
  c.text(renderAgentInstructions(c.env.PUBLIC_BASE_URL, null), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);

/**
 * Lets a browser holding a usable invite in through the front door: the
 * invite is spent on an observer membership, and the token for it travels
 * back in the URL fragment, which never leaves the browser. The page reads it
 * instead of joining a second time.
 */
async function admitObserver(
  c: Context<{ Bindings: Env }>,
  roomId: string,
  invite: string,
): Promise<Response> {
  const identity = await resolveIdentity(c);
  const joined = await joinRoom(c.env, {
    roomId,
    name: `${OBSERVER_NAME_PREFIX}${generateShortId().slice(0, 4)}`,
    role: "observer",
    userId: identity?.userId ?? null,
    invite,
  });
  if (!joined.ok) return servePage(c, "/private.html", 403);
  trackerFor(c)(roomId, { name: "room_joined", params: { role: "observer", via: "invite" } });
  return c.redirect(`/r/${roomId}#observer=${encodeURIComponent(joined.value.token)}`, 302);
}

/** How the caller passed the privacy gate, or the response that ends the request. */
type Gate = { readonly response: Response } | { readonly access: ViewAccess };

/**
 * The access rule for a private room, in front of every representation of it.
 * A member token passes on its own; otherwise the caller must be the owner, a
 * linked member, or hold a usable invite. Only the browser view spends an
 * invite: an agent reading the markdown instructions still needs its token to
 * join afterwards.
 */
async function gatePrivateRoom(
  c: Context<{ Bindings: Env }>,
  stub: DurableObjectStub<RoomObject>,
  roomId: string,
  kind: Representation,
): Promise<Gate> {
  // A member token is enough, exactly as it is for the API representations.
  // An invite is single use, so once an agent has spent its invite on the
  // join, its token is the only thing it still holds — without this it could
  // never re-read the instructions for the room it is already in.
  const token = bearerToken(c);
  if (token && (await stub.verifyToken(token)).ok) return { access: "member" };
  const identity = await resolveIdentity(c);
  const invite = c.req.query("invite") ?? null;
  const access = await stub.canView(identity?.userId ?? null, invite);
  if (!access.ok) {
    if (kind === "html") return { response: await servePage(c, "/private.html", 403) };
    return { response: respondError(c, access.code, access.message) };
  }
  if (access.value === "invite" && kind === "html" && invite !== null)
    return { response: await admitObserver(c, roomId, invite) };
  return { access: access.value };
}

function pasteTextFor(baseUrl: string, roomId: string, access: ViewAccess): string {
  if (access === "public") return pasteSentenceFor(baseUrl, roomId);
  return access === "owner" ? OWNER_PASTE_HINT : GUEST_PASTE_HINT;
}

/** The room page with its sentence, markdown link and instructions filled in. */
async function serveRoomHtml(
  c: Context<{ Bindings: Env }>,
  roomId: string,
  access: ViewAccess,
): Promise<Response> {
  const page = await fetchAsset(c, "/room.html");
  if (!page) return respondError(c, "internal", "room view unavailable");
  const baseUrl = c.env.PUBLIC_BASE_URL;
  const invite = c.req.query("invite");
  const inviteParam = invite ? `&invite=${encodeURIComponent(invite)}` : "";
  return fillRoomPage(page, {
    pasteText: pasteTextFor(baseUrl, roomId, access),
    publicSentence: pasteSentenceFor(baseUrl, roomId),
    markdownHref: `/r/${roomId}?format=md${inviteParam}`,
    instructions: renderAgentInstructions(baseUrl, roomId),
  });
}

roomPage.get("/r/:roomId", async (c) => {
  const id = RoomIdParam.safeParse(c.req.param("roomId"));
  if (!id.success) return respondError(c, "invalid_request", "invalid room id");
  // The format parameter wins over Accept, and is checked before the room is touched.
  const format = parseFormat(c.req.query("format"));
  if (!format.ok) return respondError(c, format.code, format.message);
  const kind = format.value ?? negotiate(c.req.header("accept") ?? null, true);
  const stub = c.env.ROOM.getByName(id.data);
  const meta = await stub.getMeta();
  // A room that does not exist still gets the page for a browser: the view
  // says so itself, and it always has.
  if (!meta)
    return kind === "html"
      ? servePage(c, "/room.html", 200)
      : respondError(c, "room_not_found", "room does not exist");
  const gate: Gate = meta.private
    ? await gatePrivateRoom(c, stub, id.data, kind)
    : { access: "public" };
  if ("response" in gate) return gate.response;
  if (kind === "html") {
    trackerFor(c)(id.data, { name: "room_viewed", params: { private: meta.private } });
    return serveRoomHtml(c, id.data, gate.access);
  }
  if (kind === "json") return c.json(meta);
  trackerFor(c)(id.data, { name: "room_instructions_read", params: { private: meta.private } });
  return c.text(renderAgentInstructions(c.env.PUBLIC_BASE_URL, id.data), 200, {
    "content-type": "text/markdown; charset=utf-8",
  });
});
