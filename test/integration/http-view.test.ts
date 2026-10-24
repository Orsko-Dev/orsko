import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, createRoomViaHttp } from "../helpers";

describe("human view", () => {
  // Platform routing of "/" to assets is exercised by the deployed e2e check, not the harness.
  it("bundles the landing page in assets", async () => {
    const res = await env.ASSETS.fetch(new URL("/index.html", BASE));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your agent and their agent, in one room.");
    expect(html).toContain("Start a room");
    expect(html).toContain("I have a link");
    expect(html).toContain('id="start-room"');
    expect(html).toContain('src="/start-room.js"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('id="how"');
    expect(html).toContain('id="agents"');
    expect(html).toContain('href="#how"');
    expect(html).toContain('href="#agents"');
    expect(html).toContain("allow network access to orsko.dev");
    expect(html).toContain("credential-shaped strings are rejected");
    expect(html).toContain("Orsko channel");
    expect(html).toContain("One socket, or four HTTP calls");
    expect(html).toContain("wss://orsko.dev/api/rooms/ID/stream");
    expect(html).toContain('"type":"hello"');
  });

  it("shows the launch video between the hero and the replay, never autoplaying with sound", async () => {
    const html = await (await env.ASSETS.fetch(new URL("/index.html", BASE))).text();
    const video = html.match(/<video\b[^>]*>/)?.[0] ?? "";
    expect(video).not.toBe("");
    expect(video).toContain(" controls");
    expect(video).toContain(" playsinline");
    expect(video).toContain('preload="metadata"');
    expect(video).toContain('poster="/media/orsko-launch-poster.jpg"');
    expect(video).toContain('width="1920"');
    expect(video).toContain('height="1080"');
    // A narrated film: the visitor starts it.
    expect(video).not.toContain("autoplay");
    expect(html).toContain('<source src="/media/orsko-launch.mp4" type="video/mp4">');
    // The live room card leads the hero; the film has its own band below it.
    expect(html.indexOf('id="replay"')).toBeGreaterThan(html.indexOf('class="hero band'));
    expect(html.indexOf("<video")).toBeGreaterThan(html.indexOf('id="replay"'));
  });

  it("bundles the launch video and its poster in assets", async () => {
    const video = await env.ASSETS.fetch(new URL("/media/orsko-launch.mp4", BASE));
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toContain("video/mp4");
    // Kept well under the Workers Assets per-file limit (25 MiB).
    expect((await video.arrayBuffer()).byteLength).toBeLessThan(25 * 1024 * 1024);
    const poster = await env.ASSETS.fetch(new URL("/media/orsko-launch-poster.jpg", BASE));
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toContain("image/jpeg");
  });

  it("serves the room page for browsers", async () => {
    const { roomId } = await createRoomViaHttp();
    const res = await SELF.fetch(`${BASE}/r/${roomId}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="transcript"');
  });

  it("bundles app.js in assets", async () => {
    const res = await env.ASSETS.fetch(new URL("/app.js", BASE));
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("waitSeconds");
    expect(js).toContain("behind by ");
    expect(js).toContain("caught up");
    // Read state is owned by refreshMembers alone once a token exists, and a
    // member without numeric read state is shown by name only.
    expect(js).toContain("if (!presenceToken)");
    expect(js).toContain('typeof member.readThrough !== "number"');
  });

  it("bundles the shared start-room module in assets", async () => {
    const res = await env.ASSETS.fetch(new URL("/start-room.js", BASE));
    expect(res.status).toBe(200);
    const js = await res.text();
    // The mount both pages call, and the sentence builder behind the panel.
    expect(js).toContain("function mount(container, options)");
    expect(js).not.toContain("function pasteSentence");
    expect(js).toContain("data.pasteSentence");
    expect(js).toContain("window.orskoStartRoom");
    expect(js).toContain("wireCopy");
    expect(js).not.toContain('curl -H "Accept: text/markdown"');
    // The button row it renders, and the panel's copy buttons.
    expect(js).toContain("Start a room");
    expect(js).toContain('id="copy-paste"');
    expect(js).toContain('id="copy-url"');
    expect(js).toContain('id="private-toggle"');
    expect(js).toContain('id="invite-note"');
    expect(js).toContain('id="invite-error"');
    // A room is created, and a private one gets its first invite at once.
    expect(js).toContain('"/api/rooms"');
    expect(js).toContain('"/invites"');
    expect(js).toContain('"/api/me"');
  });

  it("drives the room view over the stream, with a long-poll fallback", async () => {
    const res = await env.ASSETS.fetch(new URL("/app.js", BASE));
    expect(res.status).toBe(200);
    const js = await res.text();
    // The socket: its URL, the handshake, and the read receipt sent after both
    // the welcome and every message.
    expect(js).toContain("function streamUrl()");
    expect(js).toContain('"/api/rooms/" + roomId + "/stream"');
    expect(js).toContain('send({ type: "hello", token: token, since: seen })');
    expect(js).toContain('send({ type: "read", since: seen })');
    // Presence: a filled dot in front of an agent holding a socket.
    expect(js).toContain('m.connected ? "\\u25cf " : ""');
    // Falling back: two failed connects, counting a socket that is welcomed
    // and then dropped inside the flap window.
    expect(js).toContain("var STREAM_FAILURES_BEFORE_POLL = 2;");
    expect(js).toContain("var STREAM_FLAP_WINDOW_MS = 5000;");
    expect(js).toContain("failures >= STREAM_FAILURES_BEFORE_POLL");
    expect(js).toContain("Date.now() - welcomedAt >= STREAM_FLAP_WINDOW_MS");
  });

  it("bundles the private-room page and the invite panel in assets", async () => {
    const page = await env.ASSETS.fetch(new URL("/private.html", BASE));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("This room is private");
    expect(html).toContain('href="/signin"');
    expect(html).toContain('id="nav-account"');

    const js = await env.ASSETS.fetch(new URL("/invites.js", BASE));
    expect(js.status).toBe(200);
    const panel = await js.text();
    // The owner panel renders from the room details, never from a probe of
    // the owner-only invite list.
    expect(panel).not.toContain("if (!res.ok) return false;");
    expect(panel).toContain("meta.viewer.isOwner");
    expect(panel).toContain('document.addEventListener("orsko:room"');
    expect(panel).toContain("if (isPrivate && !mounted.wasPrivate) mounted.invites.refresh();");
    expect(panel).toContain("Create invite");
    expect(panel).toContain("Revoke");
    expect(panel).toContain("addressedGithubLogin");
  });

  it("carries the invite through the landing page and the room view", async () => {
    const start = await (await env.ASSETS.fetch(new URL("/start-room.js", BASE))).text();
    expect(start).toContain('id="private-toggle"');
    expect(start).toContain('id="invite-note"');

    const room = await (await env.ASSETS.fetch(new URL("/room.html", BASE))).text();
    expect(room).toContain('id="invite-slot"');
    expect(room).toContain('id="private-badge"');
    expect(room).toContain("/invites.js");

    const js = await (await env.ASSETS.fetch(new URL("/app.js", BASE))).text();
    // The observer token minted for an invited browser arrives in the
    // fragment, is used instead of joining, and is cleared from the URL.
    expect(js).toContain("function observerTokenFromHash()");
    expect(js).toContain("observer=");
    expect(js).toContain("if (invitedToken) return watchAs(invitedToken);");
    // The paste sentence is the one the server builds, invite and all: the
    // browser shows the invite response's sentence and never builds its own.
    expect(start).toContain("invite.pasteSentence");
    expect(start).not.toContain('"?invite=" + invite');
    // A linked member is marked, without saying which account.
    expect(js).toContain('member.linked ? "\\u2713 " : ""');
    // A private room created without an invite says so instead of showing a
    // sentence no agent could use.
    expect(start).toContain('id="invite-error"');
    expect(start).toContain(
      "Room created, but the invite could not be issued. Open the room view to create one.",
    );
    // And a private room's page never offers the invite-less sentence to a
    // viewer who is not its owner.
    expect(js).toContain("Ask the room owner for an invite.");
  });

  it("serves the account pages with the shared nav account slot", async () => {
    for (const path of ["/index.html", "/signin.html", "/room.html", "/me.html", "/me/keys.html"]) {
      const res = await env.ASSETS.fetch(new URL(path, BASE));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="nav-account"');
      expect(html).toContain("/account.js");
    }
  });

  it("bundles the API keys page under /me/keys and drops the old /keys path", async () => {
    const res = await env.ASSETS.fetch(new URL("/me/keys.html", BASE));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("API keys");
    expect(html).toContain("shown once");
    expect(html).toContain('href="/me"');
    expect(html).toContain('src="/me/keys.js"');
    // No page is left behind at the old top-level path.
    expect((await env.ASSETS.fetch(new URL("/keys.html", BASE))).status).toBe(404);

    const js = await env.ASSETS.fetch(new URL("/me/keys.js", BASE));
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("/api/me/keys");
  });

  it("links history at its /me path and explains the empty state", async () => {
    const me = await (await env.ASSETS.fetch(new URL("/me.html", BASE))).text();
    // The keys surface is hidden for now: the page is still served, but nothing links it.
    expect(me).not.toContain('href="/me/keys"');
    expect(me).not.toContain('href="/keys"');
    expect(me).toContain(
      "Rooms you create or join while signed in show up here. Anonymous rooms stay anonymous.",
    );
    // The history page starts rooms of its own, above the filter tabs.
    expect(me).toContain('src="/start-room.js"');
    expect(me).toContain("Start a room");
    expect(me.indexOf('id="start-room"')).toBeLessThan(me.indexOf('class="filter-tabs"'));

    const meJs = await (await env.ASSETS.fetch(new URL("/me.js", BASE))).text();
    expect(meJs).toContain("window.orskoStartRoom.mount");
    expect(meJs).toContain("function refresh()");

    const account = await (await env.ASSETS.fetch(new URL("/account.js", BASE))).text();
    // The keys entry stays in the code path behind one flag, off by default.
    expect(account).toContain("SHOW_API_KEYS");
    expect(account).toContain("const SHOW_API_KEYS = false;");
    expect(account).toContain('keys.href = "/me/keys"');
    expect(account).toContain('history.href = "/me"');
    // The name text is hidden below 640px (see style.css), so the account
    // button's aria-label is what carries the user's name into its
    // accessible name at every width.
    expect(account).toContain('summary.setAttribute("aria-label", name + " account menu")');
    // A magic-link user has no avatarUrl, and a GitHub avatar URL can go
    // dead: both degrade to the same fallback tile instead of an empty or
    // broken avatar slot.
    expect(account).toContain("function avatarFallback(user)");
    expect(account).toContain('img.addEventListener("error"');
    expect(account).toContain("img.replaceWith(avatarFallback(user))");

    const css = await (await env.ASSETS.fetch(new URL("/style.css", BASE))).text();
    expect(css).toContain(".account-avatar-fallback {");
  });

  it("bundles the replay transcript in assets", async () => {
    const res = await env.ASSETS.fetch(new URL("/replay.js", BASE));
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("alice joined");
    expect(js).toContain("bob joined");
    expect(js).toContain("slugify");
    expect(js).toContain("bob left");
  });

  const PAGES = [
    "/index.html",
    "/signin.html",
    "/room.html",
    "/me.html",
    "/me/keys.html",
    "/private.html",
    "/connect.html",
    "/privacy.html",
  ];

  it("self-hosts both faces and reads the brand tokens the pages link", async () => {
    const res = await env.ASSETS.fetch(new URL("/style.css", BASE));
    expect(res.status).toBe(200);
    const css = await res.text();
    // The tokens arrive by their own link tag, not by a render-blocking import.
    expect(css).not.toContain("@import");
    expect(css).toContain("/fonts/manrope-variable-latin.woff2");
    expect(css).toContain("/fonts/jetbrains-mono-variable-latin.woff2");
    expect(css).toContain("font-display: swap");
    expect(css).toContain("unicode-range");
    // The palette comes from the brand tokens, in both grounds.
    expect(css).toContain("var(--orsko-paper)");
    expect(css).toContain("var(--orsko-ink-dark)");
    expect(css).toContain('[data-theme="dark"]');
    // The old green accent and warm off-white are gone.
    expect(css).not.toContain("#2f6f4f");
    expect(css).not.toContain("#fafaf7");

    for (const path of ["/fonts/manrope-variable-latin.woff2", "/brand/tokens.css"]) {
      expect((await env.ASSETS.fetch(new URL(path, BASE))).status).toBe(200);
    }
  });

  it("prevents horizontal overflow instead of hiding it", async () => {
    const css = await (await env.ASSETS.fetch(new URL("/style.css", BASE))).text();
    expect(css).not.toContain("overflow-x: hidden");
    // Wide content scrolls inside its own box.
    expect(css).toContain("overflow-x: auto");
    // The nav mark holds at 44px, so its circle stays at 22px on mobile too.
    expect(css).toContain("height: 44px");
    expect(css).not.toContain("height: 36px");
    // With no room left beside a 44px lockup at 375px, the account name steps
    // aside below 640px rather than clipping next to the avatar.
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain(".account-name { display: none; }");
  });

  it("gives every page the brand head: icons, manifest, card and theme init", async () => {
    for (const path of PAGES) {
      const res = await env.ASSETS.fetch(new URL(path, BASE));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
      expect(html).toContain('<link rel="manifest" href="/site.webmanifest">');
      // The tokens load in parallel with the stylesheet that reads them, and
      // ahead of it, so the custom properties are defined by first paint.
      const tokens = html.indexOf('<link rel="stylesheet" href="/brand/tokens.css">');
      const sheet = html.indexOf('<link rel="stylesheet" href="/style.css">');
      expect(tokens).toBeGreaterThan(-1);
      expect(sheet).toBeGreaterThan(tokens);
      expect(html).toContain('property="og:image" content="https://orsko.dev/brand/og-image.png"');
      expect(html).toContain('name="twitter:card" content="summary_large_image"');
      expect(html).toContain("A room where agents on different machines work on one problem.");
      // The stored theme is applied before first paint, so no page flashes.
      expect(html).toContain('localStorage.getItem("orsko-theme")');
      expect(html).toContain('document.documentElement.setAttribute("data-theme",t)');
      expect(html).toContain('src="/theme.js"');
      expect(html).toContain('id="nav-theme"');
      // The old accent never survived into a page.
      expect(html).not.toContain("#2f6f4f");
    }
  });

  it("keeps the header to two flex groups with no start-room trigger of its own", async () => {
    for (const path of PAGES) {
      const res = await env.ASSETS.fetch(new URL(path, BASE));
      expect(res.status).toBe(200);
      const html = await res.text();
      const header = html.match(/<header class="nav">[\s\S]*?<\/header>/)?.[0];
      expect(header).toBeDefined();
      // The hero (landing) and /me's own start-room block own the call to
      // action; the header never carries a trigger of its own, on any page.
      expect(header).not.toContain("data-start-room");
      // Two groups, split by justify-content in the CSS: the lockup and
      // section links on the left, the theme control and account slot (or
      // sign-in link) on the right. No absolutely positioned or floating
      // element sits between them.
      expect(header).toContain('class="nav-left"');
      expect(header).toContain('class="nav-tail"');
      expect(header).toMatch(/<div class="nav-left">[\s\S]*<\/div>\s*<span class="nav-tail">/);
    }

    const css = await (await env.ASSETS.fetch(new URL("/style.css", BASE))).text();
    expect(css).toContain(
      ".nav-inner { display: flex; align-items: center; justify-content: space-between;",
    );
    expect(css).not.toContain("margin-right: auto");
    expect(css).not.toContain("margin-left: auto");
  });

  it("keeps exactly one start-room trigger on the landing page, owned by the hero", async () => {
    const html = await (await env.ASSETS.fetch(new URL("/index.html", BASE))).text();
    const triggers = html.match(/data-start-room/g) ?? [];
    expect(triggers).toHaveLength(1);
    // It sits in the hero, after the header closes, not in the nav.
    expect(html.indexOf("data-start-room")).toBeGreaterThan(html.indexOf("</header>"));
  });

  it("carries the horizontal lockup in the nav of the landing page", async () => {
    const html = await (await env.ASSETS.fetch(new URL("/index.html", BASE))).text();
    expect(html).toContain('class="brand-lockup"');
    expect(html).toContain('viewBox="0 0 438.04 152.64"');
    expect(html).toContain('fill="currentColor"');
    // The mark itself: the solid half and the ring, as drawn in the pack.
    expect(html).toContain("M22.5 6.063A18 18 0 0 0 22.5 41.937Z");
    // Never coloured: the accent is never painted inside the mark.
    expect(html).not.toContain('fill="#2438C8"');
  });

  it("serves the brand assets the pages reference", async () => {
    for (const path of [
      "/favicon.svg",
      "/favicon.ico",
      "/site.webmanifest",
      "/brand/og-image.png",
      "/brand/orsko-mark-email.png",
      "/brand/orsko-mark-email-paper.png",
    ]) {
      const res = await env.ASSETS.fetch(new URL(path, BASE));
      expect(res.status).toBe(200);
    }
  });

  it("serves the brand guidelines at /brand", async () => {
    const res = await SELF.fetch(`${BASE}/brand`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Orsko Brand Guidelines");
    // A product route, so it must not put the browser in quirks mode.
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Self-hosted there too: the pack's Google Fonts link does not ship.
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).toContain("/fonts/manrope-variable-latin.woff2");
  });

  it("renders the three-state theme control from theme.js", async () => {
    const res = await env.ASSETS.fetch(new URL("/theme.js", BASE));
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain('var KEY = "orsko-theme"');
    expect(js).toContain('"system"');
    expect(js).toContain('"light"');
    expect(js).toContain('"dark"');
    expect(js).toContain('root.setAttribute("data-theme", mode)');
    expect(js).toContain('root.removeAttribute("data-theme")');
  });

  it("renders the session features on the room page", async () => {
    const room = await (await env.ASSETS.fetch(new URL("/room.html", BASE))).text();
    expect(room).toContain('id="public-notice"');
    expect(room).toContain("Public room. Anyone with this link can read it.");
    expect(room).toContain('id="outcome"');
    expect(room).toContain('id="waiting"');
    expect(room).toContain("Waiting for another agent to join");
    expect(room).toContain('id="download-transcript"');
    expect(room).toContain("Download transcript");
    // The outcome is pinned above the members line and the transcript.
    expect(room.indexOf('id="outcome"')).toBeLessThan(room.indexOf('id="members"'));
    expect(room.indexOf('id="outcome"')).toBeLessThan(room.indexOf('id="transcript"'));
    expect(room.indexOf('src="/room-panels.js"')).toBeGreaterThan(-1);
    expect(room.indexOf('src="/room-panels.js"')).toBeLessThan(room.indexOf('src="/app.js"'));

    const panels = await (await env.ASSETS.fetch(new URL("/room-panels.js", BASE))).text();
    expect(panels).toContain('"/transcript.md"');
    expect(panels).toContain("function renderOutcome(outcome)");
    expect(panels).toContain("agentCount !== 1");
    expect(panels).toContain("window.orskoRoomPanels");

    const js = await (await env.ASSETS.fetch(new URL("/app.js", BASE))).text();
    // Away members are greyed out; the owner comes from the room details.
    expect(js).toContain('away: m.status === "away"');
    expect(js).toContain("is-away");
    expect(js).toContain("meta.viewer && meta.viewer.isOwner");
    expect(js).not.toContain("function ownsRoom()");
    expect(js).toContain('new CustomEvent("orsko:room", { detail: meta })');
    // A refused observer token is replaced by joining again; never for an
    // invite. Rejoining is bounded rather than one-shot: it is allowed again
    // once the token from the last rejoin has proven itself stable for
    // REJOIN_STABLE_MS, so a laptop that sleeps twice does not show "ended"
    // on the second wake, but a token refused right after a rejoin still
    // ends the view instead of looping.
    expect(js).toContain("function rejoin()");
    expect(js).toContain("if (rejoined || invitedToken || ended) return false;");
    expect(js).toContain("if (r.status === 401 && rejoin()) return null;");
    expect(js).toContain('frame.code === "invalid_token") { refused = true; return; }');
    expect(js).toContain("var REJOIN_STABLE_MS = 60000;");
    expect(js).toContain("function noteTokenWorking()");
    expect(js).toContain("stableTimer = setTimeout(function () {");
    expect(js).toContain("panels.wireDownload(roomId, metaHeaders);");
    // refreshMeta is coalesced: a burst of calls (one per replayed system
    // message on reconnect, say) becomes at most one in-flight request plus
    // one trailing request queued behind it, never a GET per message.
    expect(js).toContain("function requestMeta()");
    expect(js).toContain("var metaRequest = null;");
    expect(js).toContain("var metaQueued = false;");
    expect(js).toContain("if (metaRequest) { metaQueued = true; return metaRequest; }");
    // Presence still updates the waiting and members lines when the agent
    // count drops to zero, instead of leaving the last render stuck on screen.
    expect(js).toContain("function renderPresence(members, lastSeq) {");
    expect(js).toContain("if (!members) return;");
    expect(js).not.toContain("if (!members || !members.length) return;");
    expect(js).not.toContain("if (items.length) renderMembersList(items);");

    const panel = await (await env.ASSETS.fetch(new URL("/invites.js", BASE))).text();
    expect(panel).toContain("Public: anyone with the link can read and join");
    expect(panel).toContain("Private: only invited agents can join");
    expect(panel).toContain('"/private"');

    const start = await (await env.ASSETS.fetch(new URL("/start-room.js", BASE))).text();
    // Signed-in visitors start private; the API default is untouched.
    expect(start).toContain("toggle.checked = true;");

    const css = await (await env.ASSETS.fetch(new URL("/style.css", BASE))).text();
    expect(css).toContain(".members .member.is-away {");
    expect(css).toContain(".notice {");
    expect(css).toContain(".outcome-text {");
  });

  it("shows the ?error= code from a GitHub sign-in redirect as a message", async () => {
    const html = await (await env.ASSETS.fetch(new URL("/signin.html", BASE))).text();
    expect(html).toContain('id="signin-error"');
    expect(html).toContain('role="alert"');

    const js = await (await env.ASSETS.fetch(new URL("/signin.js", BASE))).text();
    expect(js).toContain("signin-error");
    expect(js).toContain("Sign-in is not configured on this deployment yet.");
    expect(js).toContain("That sign-in link is not valid. Try again.");
    expect(js).toContain("replaceState");
  });

  it("renders the relay seat on the room page, in ES5, with textContent only", async () => {
    const room = await (await env.ASSETS.fetch(new URL("/room.html", BASE))).text();
    // #relay starts hidden: a room that fails to load (an unknown room)
    // never dispatches orsko:room, so the panel must not default to visible.
    expect(room).toContain('<details id="relay" class="card relay hidden">');
    expect(room).toContain("<summary>Relay for an assistant</summary>");
    expect(room.indexOf("<summary>How an agent joins</summary>")).toBeLessThan(
      room.indexOf("<summary>Relay for an assistant</summary>"),
    );
    for (const id of [
      "relay-name",
      "relay-join",
      "relay-invite-row",
      "relay-invite",
      "relay-status",
      "relay-copy",
      "relay-block",
      "relay-reply",
      "relay-post",
      "relay-outcome",
      "relay-leave",
      "relay-note",
      "relay-error",
    ]) {
      expect(room).toContain(`id="${id}"`);
    }
    expect(room).toContain(">Join as agent<");
    expect(room).toContain("Paste your assistant's reply");
    expect(room).toContain('src="/relay.js"');

    const relay = await (await env.ASSETS.fetch(new URL("/relay.js", BASE))).text();
    expect(relay).toContain('var STORAGE_PREFIX = "orsko:relay:";');
    expect(relay).toContain("window.sessionStorage");
    expect(relay).toContain('role: "agent"');
    expect(relay).toContain('"/members"');
    expect(relay).toContain('"/outcome"');
    expect(relay).toContain('"/leave"');
    expect(relay).toContain("res.status === 401");
    expect(relay).toContain('"Your seat ended. Take a new seat to keep relaying."');
    expect(relay).toContain(
      '"If you have the Orsko connector with read tools, you can read this room yourself with room " + roomLink + " and token " + seat.token + "; do not post the token anywhere."',
    );
    expect(relay).toContain('"Reply with only the message to post as " + seat.name + "."');
    expect(relay).toContain(
      '" new messages arrived. Copy them for your assistant before its next reply."',
    );
    expect(relay).toContain('m.from + " (#" + m.seq + "): " + m.text');
    expect(relay).toContain('"Post as " + seat.name');
    expect(relay).toContain("textContent");
    expect(relay).toContain('"orsko:message"');
    expect(relay).not.toContain("pagehide");
    expect(relay).not.toContain("innerHTML");
    expect(relay).not.toMatch(/=>|\bconst\b|\blet\b|\bclass\b|`/);
    // relay.js shows #relay only once the room details have loaded.
    expect(relay).toContain('if (relay) relay.classList.remove("hidden");');
    // The clipboard promise is returned from its .then so .finally cannot
    // re-enable the Copy button before the cursor has advanced; afterCopy
    // guards against a Leave that ran while the copy was in flight.
    expect(relay).toContain("return navigator.clipboard.writeText(block).then(function () {");
    expect(relay).toContain("function afterCopy() {\n        if (!seat) return;");
    // The seat token, embedded in the brief, is cleared from the DOM once it
    // is no longer needed: after a successful copy, when the seat ends, and
    // on leave.
    const blockClears = relay.match(/text\(el\("relay-block"\), ""\)/g) ?? [];
    expect(blockClears.length).toBeGreaterThanOrEqual(3);

    const app = await (await env.ASSETS.fetch(new URL("/app.js", BASE))).text();
    expect(app).toContain(
      'document.dispatchEvent(new CustomEvent("orsko:message", { detail: m }));',
    );
  });
});
