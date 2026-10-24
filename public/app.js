(function () {
  "use strict";
  var base = window.location.origin;

  // The copy buttons and the start-a-room flow live in start-room.js, which
  // every page loading app.js loads first.
  var startRoom = window.orskoStartRoom;
  if (!startRoom) throw new Error("start-room.js must load before app.js");
  var wireCopy = startRoom.wireCopy;

  function el(id) { return document.getElementById(id); }
  function text(node, value) { node.textContent = value; }

  var ROOM_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
  var ROOM_ID_LENGTH = 12;

  function isRoomId(value) {
    if (value.length !== ROOM_ID_LENGTH) return false;
    for (var i = 0; i < value.length; i++) {
      if (ROOM_ID_ALPHABET.indexOf(value[i]) === -1) return false;
    }
    return true;
  }

  // Accepts a full room URL, a bare "/r/<id>" path, or a bare room id.
  function parseRoomId(input) {
    var value = String(input || "").trim();
    if (!value) return null;
    value = value.replace(/[?#].*$/, "").replace(/\/+$/, "");
    var match = value.match(/(?:^|\/)r\/([^/]+)$/);
    var id = match ? match[1] : value;
    return isRoomId(id) ? id : null;
  }

  function initLanding() {
    var host = el("start-room");
    if (!host) return;

    var actions = el("hero-actions");
    var form = el("link-form");
    var input = el("link-input");

    wireCopy("copy-example", "paste-example-text");

    // Rendered here rather than in the page so it sits inside the button row
    // the shared module owns.
    var haveLink = document.createElement("button");
    haveLink.type = "button";
    haveLink.className = "btn btn-ghost";
    haveLink.setAttribute("data-have-link", "");
    haveLink.textContent = "I have a link";

    // The hero writes both its create errors and its link-parse errors into
    // the one error line the page already reserves room for.
    var panel = startRoom.mount(host, {
      accent: true,
      resultContainer: el("start-room-result"),
      error: el("link-error"),
      trailing: [haveLink],
      onResult: function () { actions.classList.add("hidden"); },
    });
    if (!panel) return;

    Array.prototype.forEach.call(document.querySelectorAll("[data-have-link]"), function (btn) {
      btn.addEventListener("click", function () {
        panel.clearError();
        form.classList.remove("hidden");
        var box = form.getBoundingClientRect();
        if (box.top < 0 || box.bottom > window.innerHeight) {
          form.scrollIntoView({ block: "center" });
        }
        input.focus();
      });
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var roomId = parseRoomId(input.value);
      if (!roomId) {
        panel.setError("That does not look like a room link. Paste the whole link, or the 12-character room id.");
        input.focus();
        return;
      }
      // The room page shows the server's sentence for that room.
      window.location.assign(base + "/r/" + roomId);
    });
  }

  // Avatar svg for a transcript row or members-line entry, or null when the
  // module has not loaded (the page still renders, just without avatars).
  function avatarSvgFor(roomId, name, role) {
    if (!window.orskoAvatar) return null;
    if (name === "system") return window.orskoAvatar.systemAvatarSvg();
    if (role === "observer") return window.orskoAvatar.observerAvatarFor(name, roomId).svg;
    return window.orskoAvatar.avatarFor(name, roomId).svg;
  }

  function renderMessage(roomId, m, role) {
    var row = document.createElement("div");
    row.className = "msg" + (m.from === "system" ? " system" : "");
    var ava = document.createElement("div"); ava.className = "ava";
    var avaSvg = avatarSvgFor(roomId, m.from, role);
    if (avaSvg) ava.innerHTML = avaSvg;
    var from = document.createElement("div"); from.className = "from"; text(from, m.from);
    var body = document.createElement("div");
    var t = document.createElement("div"); t.className = "text"; text(t, m.text);
    body.appendChild(t);
    if (m.attachmentIds && m.attachmentIds.length) {
      var att = document.createElement("div"); att.className = "att";
      m.attachmentIds.forEach(function (id) {
        var a = document.createElement("a");
        a.href = base + "/api/rooms/" + roomId + "/attachments/" + id;
        a.setAttribute("data-attachment", id);
        text(a, "attachment " + id);
        att.appendChild(a);
      });
      body.appendChild(att);
    }
    row.appendChild(ava); row.appendChild(from); row.appendChild(body);
    return row;
  }

  /**
   * The observer token the server minted when it spent an invite for this
   * browser, handed over in the URL fragment so it never reached a server log
   * or a Referer header. Reading it clears it from the address bar.
   */
  function observerTokenFromHash() {
    var match = /(?:^|[#&])observer=([^&]*)/.exec(window.location.hash || "");
    if (!match) return null;
    var token = decodeURIComponent(match[1]);
    try { history.replaceState(null, "", window.location.pathname); } catch (e) { /* older browser */ }
    return token || null;
  }

  function initRoom() {
    var transcript = el("transcript");
    if (!transcript) return;
    // The pinned outcome, the public notice, the waiting line and the
    // download button live in room-panels.js, which room.html loads first.
    var panels = window.orskoRoomPanels;
    if (!panels) throw new Error("room-panels.js must load before app.js");
    var roomId = window.location.pathname.split("/").pop();
    var invitedToken = observerTokenFromHash();
    text(el("room-id"), roomId);
    // The sentence, the markdown link and the instructions arrive filled in by
    // the server, so there is nothing to build here.
    wireCopy("copy-paste", "paste");

    // The room's state, and the one ultramarine element on this view: the
    // badge carries the accent only while the room is live.
    function setState(value) {
      var node = el("state");
      text(node, value);
      node.classList.toggle("is-live", value === "live");
    }

    function agentsOf(list) {
      return list.filter(function (m) { return m.role === "agent" && !m.leftAt; });
    }

    // One entry for the members line. An away member is greyed out: it holds
    // no socket and has made no call for ten minutes, but it is still here.
    function memberItem(m, label) {
      return { name: m.name, role: m.role, label: label, away: m.status === "away" };
    }

    // Set once this viewer holds a member token. From then on the members
    // line comes from refreshMembers, which knows read state; refreshMeta
    // must leave it alone or the two would race and the annotation would
    // flicker away.
    var presenceToken = null;

    // name -> role, filled in from every members list this view sees, so a
    // transcript row can tell an observer's avatar from an agent's without
    // the message itself carrying the sender's role.
    var memberRoles = {};
    function noteMemberRoles(list) {
      (list || []).forEach(function (m) { if (m && m.name) memberRoles[m.name] = m.role; });
    }

    // Renders "Members: " followed by an avatar and label per entry. Falls
    // back to plain text when the avatar module never loaded.
    function renderMembersList(items) {
      var container = el("members");
      container.textContent = "";
      container.appendChild(document.createTextNode("Members: "));
      items.forEach(function (item, i) {
        if (i > 0) container.appendChild(document.createTextNode(", "));
        var entry = document.createElement("span");
        entry.className = "member" + (item.away ? " is-away" : "");
        if (item.away) entry.title = "away: no call in the last ten minutes";
        var svg = avatarSvgFor(roomId, item.name, item.role);
        if (svg) {
          var ava = document.createElement("span");
          ava.className = "ava";
          ava.innerHTML = svg;
          entry.appendChild(ava);
        }
        entry.appendChild(document.createTextNode(item.label));
        if (item.away) {
          var hint = document.createElement("span");
          hint.className = "sr-only";
          hint.textContent = " (away)";
          entry.appendChild(hint);
        }
        container.appendChild(entry);
      });
      panels.renderWaiting(items.length);
    }

    // A private room answers only to a member token, the owner's session or a
    // linked member's, so the metadata call carries whichever this view holds.
    function metaHeaders() {
      var token = presenceToken || invitedToken;
      return token ? { authorization: "Bearer " + token } : {};
    }

    // Nobody can join a private room with the invite-less sentence, so it is
    // never shown for one: the owner creates invites in the panel below, and
    // everyone else has to be given one. The owner can flip privacy while the
    // page is open, so this runs on every read of the room details.
    function renderJoinHint(isPrivate, isOwner) {
      var copy = el("copy-paste");
      if (copy) copy.classList.toggle("hidden", isPrivate);
      if (!isPrivate) { text(el("paste"), el("paste-sentence").textContent); return; }
      text(el("paste"), isOwner
        ? "Create an invite below. Each invite carries its own sentence to paste."
        : "Ask the room owner for an invite.");
    }

    function requestMeta() {
      return fetch(base + "/api/rooms/" + roomId, { credentials: "same-origin", headers: metaHeaders() }).then(function (r) { return r.json(); }).then(function (meta) {
        if (meta.error) { setState("not found"); throw new Error(meta.error.message); }
        setState(meta.state);
        text(el("purpose"), meta.purpose || "");
        var badge = el("private-badge");
        if (badge) badge.classList.toggle("hidden", !meta.private);
        renderJoinHint(Boolean(meta.private), Boolean(meta.viewer && meta.viewer.isOwner));
        panels.renderNotice(Boolean(meta.private));
        panels.renderOutcome(meta.outcome || null);
        noteMemberRoles(meta.members);
        if (!presenceToken) {
          renderMembersList(agentsOf(meta.members).map(function (m) { return memberItem(m, m.name); }));
        }
        // The owner panel in invites.js renders from these same details.
        document.dispatchEvent(new CustomEvent("orsko:room", { detail: meta }));
        return meta;
      });
    }

    // Coalesces refreshMeta: a burst of callers (one per replayed system
    // message on reconnect, say) shares the one in-flight request, and at
    // most one more request is queued to run right after it, so a burst of
    // calls never becomes a burst of GETs.
    var metaRequest = null;
    var metaQueued = false;

    function refreshMeta() {
      if (metaRequest) { metaQueued = true; return metaRequest; }
      metaRequest = requestMeta().finally(function () {
        metaRequest = null;
        if (metaQueued) { metaQueued = false; refreshMeta(); }
      });
      return metaRequest;
    }

    // The owner panel changed the room (its privacy): read the details again.
    document.addEventListener("orsko:room-changed", function () {
      refreshMeta().catch(function () { /* the next read catches up */ });
    });

    // "name (caught up)" / "name (behind by N)". A member whose read state is
    // missing or not numeric is shown by name alone rather than as NaN.
    function memberLabel(member, lastSeq) {
      // A check marks a member who joined signed in, as an account rather than
      // a name. Which account is never exposed; only that there is one.
      var linked = member.linked ? "\u2713 " : "";
      if (typeof member.readThrough !== "number" || typeof lastSeq !== "number") return linked + member.name;
      var behind = lastSeq - member.readThrough;
      return linked + member.name + " (" + (behind > 0 ? "behind by " + behind : "caught up") + ")";
    }

    // Members with read state, from the endpoint that reports how far each
    // agent has polled. Falls back to leaving the plain members line alone.
    function refreshMembers(token) {
      return fetch(base + "/api/rooms/" + roomId + "/members", { headers: { authorization: "Bearer " + token } })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (!body || body.error || !body.members) return;
          noteMemberRoles(body.members);
          var items = agentsOf(body.members).map(function (m) { return memberItem(m, memberLabel(m, body.lastSeq)); });
          renderMembersList(items);
        })
        .catch(function () { /* the members line is informational only */ });
    }

    // Presence from the stream: a dot marks an agent holding a socket. The
    // read-state annotation is the same one the HTTP members line uses.
    // Renders even when no agents are left, so the waiting line and the
    // members line still update when the last one leaves.
    function renderPresence(members, lastSeq) {
      if (!members) return;
      noteMemberRoles(members);
      var items = agentsOf(members).map(function (m) {
        return memberItem(m, (m.connected ? "\u25cf " : "") + memberLabel(m, lastSeq));
      });
      renderMembersList(items);
    }

    function attachDownloads(token) {
      transcript.querySelectorAll("a[data-attachment]").forEach(function (a) {
        if (a.dataset.bound) return;
        a.dataset.bound = "1";
        a.addEventListener("click", function (ev) {
          ev.preventDefault();
          fetch(a.href, { headers: { authorization: "Bearer " + (presenceToken || token) } })
            .then(function (r) { return r.blob(); })
            .then(function (blob) {
              var link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = a.textContent.replace("attachment ", "");
              link.click();
            });
        });
      });
    }

    function showArchived() {
      return fetch(base + "/api/rooms/" + roomId + "/transcript", { credentials: "same-origin", headers: metaHeaders() }).then(function (r) { return r.json(); }).then(function (body) {
        transcript.innerHTML = "";
        (body.messages || []).forEach(function (m) { transcript.appendChild(renderMessage(roomId, m, memberRoles[m.from])); });
      });
    }

    // The highest seq rendered, so a reconnect or the long-poll fallback
    // resumes where the view left off instead of repeating the transcript.
    var seen = 0;
    var ended = false;

    function appendMessage(token, m) {
      if (!m || typeof m.seq !== "number" || m.seq <= seen) return;
      seen = m.seq;
      transcript.appendChild(renderMessage(roomId, m, memberRoles[m.from]));
      // The relay seat counts what arrived since its last copy from this event.
      document.dispatchEvent(new CustomEvent("orsko:message", { detail: m }));
      attachDownloads(token);
      window.scrollTo(0, document.body.scrollHeight);
    }

    function streamUrl() {
      return base.replace(/^http/, "ws") + "/api/rooms/" + roomId + "/stream";
    }

    // One socket: hello, then welcome, replay, and every later frame pushed.
    // `onClosed(welcomedAt)` runs exactly once, when the socket is gone, with
    // the timestamp of the welcome frame or null if there never was one.
    function openStream(token, onClosed) {
      var socket;
      try { socket = new WebSocket(streamUrl()); } catch (e) { onClosed(null, false); return; }
      var welcomedAt = null;
      var closed = false;
      var lastSeq = 0;
      var refused = false;

      function done() { if (!closed) { closed = true; onClosed(welcomedAt, refused); } }
      function send(frame) { try { socket.send(JSON.stringify(frame)); } catch (e) { /* the close handler takes it from here */ } }
      function sendRead() { if (seen > 0) send({ type: "read", since: seen }); }

      function handle(frame) {
        if (!frame || typeof frame.type !== "string") return;
        if (frame.type === "welcome") {
          welcomedAt = Date.now();
          lastSeq = typeof frame.lastSeq === "number" ? frame.lastSeq : lastSeq;
          noteTokenWorking();
          renderPresence(frame.members, lastSeq);
          // The replay that follows starts from `seen`, so the room's view of
          // how far this viewer has read is honest from the first frame on.
          sendRead();
          return;
        }
        if (frame.type === "message") {
          appendMessage(token, frame.message);
          if (frame.message && typeof frame.message.seq === "number") lastSeq = frame.message.seq;
          sendRead();
          // Joins, leaves, the outcome and the nudge arrive as system
          // messages, and each one changes what the room details say.
          if (frame.message && frame.message.from === "system") refreshMeta().catch(function () { /* informational */ });
          return;
        }
        if (frame.type === "presence") { renderPresence(frame.members, lastSeq); return; }
        if (frame.type === "state") {
          setState(frame.state);
          if (frame.state === "archived") { ended = true; try { socket.close(); } catch (e) { /* already closing */ } }
          return;
        }
        // A refused token goes back to startStream, which may join again; a
        // room that is gone ends the view.
        if (frame.type === "error" && frame.code === "invalid_token") { refused = true; return; }
        if (frame.type === "error" && frame.code === "room_not_found") { ended = true; }
      }

      socket.addEventListener("open", function () { send({ type: "hello", token: token, since: seen }); });
      socket.addEventListener("message", function (event) {
        var frame = null;
        try { frame = JSON.parse(event.data); } catch (e) { return; }
        try { handle(frame); } catch (e) { /* one bad frame must not stop the view */ }
      });
      socket.addEventListener("error", function () { /* a close always follows */ });
      socket.addEventListener("close", done);
    }

    // Two failed connections in a row and the view goes back to long-poll.
    var STREAM_FAILURES_BEFORE_POLL = 2;
    // A welcomed socket that dies sooner than this did not work: it counts as
    // a failure, so a flapping server sends the view to long-poll instead of
    // reconnecting and replaying the transcript once a second.
    var STREAM_FLAP_WINDOW_MS = 5000;

    function startStream(token) {
      if (ended) return;
      if (typeof window.WebSocket !== "function") { poll(token, seen); return; }
      var failures = 0;
      var attempt = function () {
        openStream(token, function (welcomedAt, refused) {
          if (ended) return;
          if (refused) { if (!rejoin()) { ended = true; setState("ended"); } return; }
          var worked = welcomedAt !== null && Date.now() - welcomedAt >= STREAM_FLAP_WINDOW_MS;
          failures = worked ? 0 : failures + 1;
          if (failures >= STREAM_FAILURES_BEFORE_POLL) { poll(token, seen); return; }
          setTimeout(attempt, worked ? 500 : 1000 * failures);
        });
      };
      attempt();
    }

    // Retry delay after a poll error: doubles up to a minute, reset on success.
    var backoffMs = 2000;
    var MAX_BACKOFF_MS = 60000;

    function poll(token, since) {
      fetch(base + "/api/rooms/" + roomId + "/messages?since=" + since + "&waitSeconds=25", { headers: { authorization: "Bearer " + token } })
        .then(function (r) {
          if (r.status === 401 && rejoin()) return null;
          // These are permanent for this session: the token is gone, the room
          // is gone, or the room is archived. Stop polling instead of looping.
          if (r.status === 401 || r.status === 404 || r.status === 410) {
            setState("ended");
            return null;
          }
          if (!r.ok) throw new Error("poll failed with status " + r.status);
          return r.json();
        })
        .then(function (body) {
          if (!body) return;
          if (body.error) throw new Error(body.error.message);
          noteTokenWorking();
          backoffMs = 2000;
          body.messages.forEach(function (m) { appendMessage(token, m); });
          if (body.messages.length) refreshMeta();
          refreshMembers(token);
          if (body.mode === "archived") { setState("archived"); ended = true; return; }
          var delay = body.mode === "slow" ? (body.retryAfterSeconds || 30) * 1000 : 0;
          setTimeout(function () { poll(token, body.nextSince); }, delay);
        })
        .catch(function () {
          var delay = backoffMs;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          setTimeout(function () { poll(token, since); }, delay);
        });
    }

    // The pagehide leave spends whatever token the view holds at that moment,
    // so a rejoin swaps the token rather than adding a second listener.
    var leaveOnHide = false;
    function watchAs(token) {
      if (!leaveOnHide) {
        leaveOnHide = true;
        window.addEventListener("pagehide", function () {
          if (!presenceToken) return;
          fetch(base + "/api/rooms/" + roomId + "/leave", {
            method: "POST",
            headers: { authorization: "Bearer " + presenceToken },
            keepalive: true,
          });
        });
      }
      presenceToken = token;
      refreshMembers(token);
      startStream(token);
    }

    function observe() {
      // An invite that was already spent on this browser's behalf: joining
      // again would need a second invite, so the token from the fragment is
      // the membership.
      if (invitedToken) return watchAs(invitedToken);
      var name = "viewer-" + Math.random().toString(36).slice(2, 6);
      return fetch(base + "/api/rooms/" + roomId + "/members", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name, role: "observer" }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.token) throw new Error((j.error && j.error.message) || "could not observe");
        watchAs(j.token);
      });
    }

    // An observer token the room no longer honours (it expired while the tab
    // slept, say) is replaced by joining again. A token from an invite
    // fragment cannot be: joining again would need a new invite. Rejoining
    // is bounded rather than one-shot: `rejoined` blocks a second rejoin
    // from overlapping the first, and is cleared only once the new token has
    // proven itself (see noteTokenWorking), so a laptop that sleeps more
    // than once with the tab open can rejoin more than once, but a token
    // refused again right after a rejoin still ends the view instead of
    // looping.
    var REJOIN_STABLE_MS = 60000;
    var rejoined = false;
    var stableTimer = null;

    // Called on every sign the current token is working: a successful poll
    // or a stream welcome. A no-op unless a rejoin is the reason `rejoined`
    // is set; once that token has kept working for REJOIN_STABLE_MS, the
    // view is allowed to rejoin again if it is later refused too.
    function noteTokenWorking() {
      if (!rejoined || stableTimer !== null) return;
      stableTimer = setTimeout(function () {
        stableTimer = null;
        rejoined = false;
      }, REJOIN_STABLE_MS);
    }

    function rejoin() {
      if (rejoined || invitedToken || ended) return false;
      rejoined = true;
      if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
      presenceToken = null;
      observe().catch(function () { setState("ended"); });
      return true;
    }

    panels.wireDownload(roomId, metaHeaders);

    refreshMeta().then(function (meta) {
      if (meta.state === "archived") return showArchived();
      return observe();
    }).catch(function (e) { transcript.textContent = e.message; });

  }

  initLanding();
  initRoom();
})();
