/* The owner panel on the room page: the privacy switch for any room the
   viewer created, and the invite list for a private one. Whether the viewer
   owns the room comes from the room details (`viewer.isOwner`), which app.js
   broadcasts as an "orsko:room" event every time it reads them, so the page
   never probes an owner-only endpoint to find out. */
(function () {
  "use strict";

  var base = window.location.origin;
  var PUBLIC_TEXT = "Public: anyone with the link can read and join";
  var PRIVATE_TEXT = "Private: only invited agents can join";

  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function roomIdOfPage() {
    var parts = window.location.pathname.split("/");
    return parts[1] === "r" && parts[2] ? parts[2] : null;
  }

  function api(roomId, path, init) {
    return fetch(base + "/api/rooms/" + roomId + "/invites" + path, init || {});
  }

  function describe(invite) {
    var to = invite.addressedEmail || invite.addressedGithubLogin || "anyone with the link";
    var label = invite.label ? invite.label + " · " : "";
    return label + to + " · " + invite.status;
  }

  // The invite panel's markup, built once and handed to panelFor to wire up.
  function buildPanel() {
    var wrap = el("details", "card invite-panel");
    wrap.appendChild(el("summary", null, "Invites"));
    var form = el("div", "label-row");
    var input = el("input", "invite-address");
    input.type = "text";
    input.placeholder = "email or GitHub login (optional)";
    input.autocomplete = "off";
    var button = el("button", "btn btn-primary btn-sm", "Create invite");
    button.type = "button";
    form.appendChild(input);
    form.appendChild(button);
    wrap.appendChild(form);

    var sentenceRow = el("div", "label-row hidden");
    var copy = el("button", "secondary", "Copy");
    copy.type = "button";
    sentenceRow.appendChild(el("span", null, "Paste to your agent"));
    sentenceRow.appendChild(copy);
    var sentence = el("pre", "invite-sentence");
    wrap.appendChild(sentenceRow);
    wrap.appendChild(sentence);

    var list = el("div", "invite-list");
    wrap.appendChild(list);
    var error = el("p", "form-error");
    error.setAttribute("role", "alert");
    wrap.appendChild(error);

    copy.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(sentence.textContent);
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy"; }, 1500);
      }
    });

    return { wrap: wrap, input: input, button: button, sentence: sentence, sentenceRow: sentenceRow, list: list, error: error };
  }

  // The address is optional, and is either an email or a GitHub login.
  function bodyFor(value) {
    var address = String(value || "").trim();
    if (!address) return {};
    return address.indexOf("@") > -1
      ? { addressedEmail: address }
      : { addressedGithubLogin: address };
  }

  // One row of the list: what the invite is, and a Revoke button while it can
  // still be used. `after` reloads the list, `onError` reports a failure.
  function inviteRow(roomId, invite, after, onError) {
    var row = el("div", "invite-row");
    row.appendChild(el("span", null, describe(invite)));
    if (invite.status !== "pending") return row;
    var revoke = el("button", "linklike", "Revoke");
    revoke.type = "button";
    revoke.addEventListener("click", function () {
      api(roomId, "/" + invite.inviteId, { method: "DELETE", credentials: "same-origin" })
        .then(after)
        .catch(function () { onError("could not revoke that invite"); });
    });
    row.appendChild(revoke);
    return row;
  }

  function panelFor(roomId) {
    var parts = buildPanel();
    var list = parts.list;
    var error = parts.error;

    function fail(message) { error.textContent = message; }

    function render(invites) {
      list.textContent = "";
      invites.forEach(function (invite) {
        list.appendChild(inviteRow(roomId, invite, refresh, fail));
      });
    }

    function refresh() {
      return api(roomId, "", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) { if (body) render(body.invites || []); })
        .catch(function () { fail("could not load the invites"); });
    }

    parts.button.addEventListener("click", function () {
      error.textContent = "";
      parts.button.disabled = true;
      api(roomId, "", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyFor(parts.input.value)),
      })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (!body.token) throw new Error((body.error && body.error.message) || "could not create an invite");
          // The token is shown once, here, in the sentence the owner sends on.
          parts.sentence.textContent = body.pasteSentence;
          parts.sentenceRow.classList.remove("hidden");
          parts.input.value = "";
          return refresh();
        })
        .catch(function (e) { error.textContent = e.message; })
        .finally(function () { parts.button.disabled = false; });
    });

    return { node: parts.wrap, refresh: refresh, render: render };
  }

  // The privacy switch: what the room is now, and one button to flip it.
  function privacyPanel(roomId) {
    var wrap = el("div", "card privacy-panel");
    var row = el("div", "label-row");
    var state = el("span", "privacy-state");
    var button = el("button", "secondary", "");
    button.type = "button";
    row.appendChild(state);
    row.appendChild(button);
    wrap.appendChild(row);
    var error = el("p", "form-error");
    error.setAttribute("role", "alert");
    wrap.appendChild(error);
    var current = null;

    function render(isPrivate) {
      current = isPrivate;
      state.textContent = isPrivate ? PRIVATE_TEXT : PUBLIC_TEXT;
      button.textContent = isPrivate ? "Make public" : "Make private";
    }

    button.addEventListener("click", function () {
      if (current === null) return;
      error.textContent = "";
      button.disabled = true;
      fetch(base + "/api/rooms/" + roomId + "/private", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ private: !current }),
      })
        .then(function (r) {
          if (r.status === 204) return;
          return r.json().then(function (body) {
            throw new Error((body.error && body.error.message) || "could not change the room's privacy");
          });
        })
        // app.js reads the room again and broadcasts it; this panel re-renders from that.
        .then(function () { document.dispatchEvent(new CustomEvent("orsko:room-changed")); })
        .catch(function (e) { error.textContent = e.message; })
        .finally(function () { button.disabled = false; });
    });

    return { node: wrap, render: render };
  }

  var mounted = null;

  /** Renders the owner panel from one read of the room details; nothing for anyone else. */
  function mount(meta) {
    var roomId = roomIdOfPage();
    var slot = document.getElementById("invite-slot");
    if (!roomId || !slot || !meta || !meta.viewer || !meta.viewer.isOwner) return;
    if (!mounted) {
      mounted = { privacy: privacyPanel(roomId), invites: panelFor(roomId), wasPrivate: false };
      slot.appendChild(mounted.privacy.node);
      slot.appendChild(mounted.invites.node);
      slot.classList.remove("hidden");
    }
    var isPrivate = Boolean(meta.private);
    mounted.privacy.render(isPrivate);
    mounted.invites.node.classList.toggle("hidden", !isPrivate);
    // The invite list is owner-only and gates nothing on a public room, so it
    // is requested only while the room is private, and again only when it
    // becomes private.
    if (isPrivate && !mounted.wasPrivate) mounted.invites.refresh();
    mounted.wasPrivate = isPrivate;
  }

  document.addEventListener("orsko:room", function (event) { mount(event.detail); });
  window.orskoInvites = { mount: mount };
})();
