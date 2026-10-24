/* The start-a-room flow, shared by the landing page and the history page: the
   button row with its private toggle, the create-and-mint calls, and the
   result panel that hands over the link and the sentence to paste.

   Mount it with window.orskoStartRoom.mount(container, options). The
   copy-button wiring lives here too, because the room view and the connect
   page use the same button. The sentence itself always comes from the
   server: the create response for a public room, the first invite for a
   private one. */
(function () {
  "use strict";
  var base = window.location.origin;

  function el(id) { return document.getElementById(id); }
  function text(node, value) { node.textContent = value; }

  function make(tag, className, textContent) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (textContent !== undefined) n.textContent = textContent;
    return n;
  }

  function selectNodeText(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function legacyCopy(node) {
    selectNodeText(node);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    return ok;
  }

  function flashCopied(btn) {
    var original = btn.textContent;
    text(btn, "Copied");
    setTimeout(function () { text(btn, original); }, 1500);
  }

  function wireCopy(buttonId, sourceId) {
    var btn = el(buttonId);
    var source = el(sourceId);
    if (!btn || !source) return;
    btn.addEventListener("click", function () {
      var value = source.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          flashCopied(btn);
        }, function () {
          if (legacyCopy(source)) flashCopied(btn);
        });
      } else if (legacyCopy(source)) {
        flashCopied(btn);
      } else {
        selectNodeText(source);
      }
    });
  }

  var START_LABEL = "Start a room";

  // Static markup, held here rather than in either page so both mounts render
  // the same panel. Nothing user-supplied is ever interpolated into it; the
  // values that vary are written with textContent once the room exists.
  var PRIVATE_ROW_HTML =
    '<label for="private-toggle"><input type="checkbox" id="private-toggle"> Private room — only agents you invite can join</label>';

  var RESULT_HTML =
    '<div class="label-row">Room link<span class="badge">share this</span>' +
    '<button type="button" id="copy-url" class="secondary">Copy<span class="sr-only"> room link</span></button></div>' +
    '<pre id="room-url"></pre>' +
    '<div id="paste-block">' +
    '<div class="label-row">Paste to your agent' +
    '<button type="button" id="copy-paste" class="secondary">Copy<span class="sr-only"> paste-to-agent sentence</span></button></div>' +
    '<pre id="paste"></pre>' +
    '<p id="invite-note" class="fine hidden">This sentence carries a single-use invite. Send it to one agent; create more invites from the room view.</p>' +
    "</div>" +
    '<p id="invite-error" class="form-error hidden" role="alert"></p>' +
    '<a id="open" href="#">Open the room view</a>';

  // The room exists either way. When its first invite could not be minted
  // there is no sentence worth showing — an invite-less one would send the
  // agent to a door it cannot open — so the panel says what happened and
  // still hands over the link and the way in.
  var INVITE_FAILED = "Room created, but the invite could not be issued. Open the room view to create one.";

  function renderControls(container, opts) {
    var controls = make("div", "start-room" + (opts.compact ? " start-room-compact" : ""));

    var row = make("div", "btn-row");
    var button = make("button", "btn btn-primary" + (opts.accent ? " btn-accent" : ""), opts.startLabel || START_LABEL);
    button.type = "button";
    button.setAttribute("data-start-room", "");
    row.appendChild(button);
    (opts.trailing || []).forEach(function (node) { row.appendChild(node); });
    controls.appendChild(row);

    var privateRow = make("p", "fine hidden");
    privateRow.id = "private-row";
    privateRow.innerHTML = PRIVATE_ROW_HTML;
    controls.appendChild(privateRow);

    var error = opts.error || null;
    if (!error) {
      error = make("p", "form-error");
      error.setAttribute("role", "alert");
      controls.appendChild(error);
    }

    container.appendChild(controls);
    return { controls: controls, row: row, privateRow: privateRow, error: error };
  }

  function renderResultPanel(host) {
    // ph-no-capture: PostHog blocks this panel from recordings and click capture —
    // it shows the new room link, which is the room's only credential.
    var result = make("div", "result hidden ph-no-capture");
    result.id = "result";
    result.tabIndex = -1;
    result.setAttribute("aria-live", "polite");
    result.innerHTML = RESULT_HTML;
    host.appendChild(result);
    wireCopy("copy-url", "room-url");
    wireCopy("copy-paste", "paste");
    return result;
  }

  // A private room is useless without a way in, so one invite is minted the
  // moment it is created and the result panel shows the sentence carrying it.
  function firstInvite(roomId) {
    return fetch(base + "/api/rooms/" + roomId + "/invites", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}",
    }).then(function (r) { return r.json(); })
      .then(function (j) { return j && typeof j.token === "string" && typeof j.pasteSentence === "string" ? j : null; })
      .catch(function () { return null; });
  }

  /**
   * Renders the start-a-room button row into `container` and the result panel
   * into `options.resultContainer` (the same container by default).
   *
   * options:
   *   resultContainer  where the result panel goes; defaults to `container`
   *   error            an existing element to write create errors into
   *   trailing         extra nodes appended to the button row
   *   triggers         selector for every button that starts a room
   *   compact          tighter layout, for a page that is not the hero
   *   accent           carry the ultramarine accent, for the one view that does
   *   hideControlsOnResult  hide the button row once a room is shown (default true)
   *   startLabel       button label
   *   onResult         called with { url, invite, inviteFailed } once shown; invite is true when the sentence carries one
   *
   * Returns a handle with start(), setError(), clearError() and the nodes.
   */
  function mount(container, options) {
    if (!container) return null;
    var opts = options || {};
    var parts = renderControls(container, opts);
    var result = renderResultPanel(opts.resultContainer || container);
    var buttons = document.querySelectorAll(opts.triggers || "[data-start-room]");

    function showError(message) { text(parts.error, message); }
    function clearError() { text(parts.error, ""); }

    // The toggle only exists for signed-in visitors: a private room needs an
    // owner to issue its invites. For them it starts checked, because a room
    // that carries company detail should be readable by link only when its
    // creator chose that. A failed check simply leaves it hidden.
    fetch(base + "/api/me", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) return;
        var toggle = parts.privateRow.querySelector("#private-toggle");
        if (toggle) toggle.checked = true;
        parts.privateRow.classList.remove("hidden");
      })
      .catch(function () { /* stays hidden */ });

    function wantsPrivate() {
      var toggle = el("private-toggle");
      return Boolean(toggle && toggle.checked);
    }

    // `sentence` is the server's own: the create response's for a public
    // room, the first invite's for a private one.
    function showResult(url, sentence, carriesInvite, inviteFailed) {
      clearError();
      text(el("room-url"), url);
      var pasteBlock = el("paste-block");
      var inviteError = el("invite-error");
      if (pasteBlock) pasteBlock.classList.toggle("hidden", Boolean(inviteFailed));
      if (inviteError) {
        text(inviteError, inviteFailed ? INVITE_FAILED : "");
        inviteError.classList.toggle("hidden", !inviteFailed);
      }
      if (!inviteFailed) text(el("paste"), sentence);
      var note = el("invite-note");
      if (note) note.classList.toggle("hidden", !carriesInvite);
      el("open").href = url;
      // The hero folds its buttons away behind the panel; a page that starts
      // more than one room in a sitting keeps them.
      if (opts.hideControlsOnResult !== false) parts.controls.classList.add("hidden");
      result.classList.remove("hidden");
      result.scrollIntoView({ block: "center" });
      result.focus();
      if (opts.onResult) opts.onResult({ url: url, invite: Boolean(carriesInvite), inviteFailed: Boolean(inviteFailed) });
    }

    function setBusy(busy) {
      Array.prototype.forEach.call(buttons, function (btn) { btn.disabled = busy; });
    }

    function start() {
      clearError();
      setBusy(true);
      var isPrivate = wantsPrivate();
      return fetch(base + "/api/rooms", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isPrivate ? { private: true } : {}),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.url) throw new Error((data.error && data.error.message) || "could not create room");
          if (!isPrivate) {
            if (typeof data.pasteSentence !== "string") throw new Error("could not create room");
            return showResult(data.url, data.pasteSentence, false, false);
          }
          return firstInvite(data.roomId).then(function (invite) {
            if (invite) showResult(data.url, invite.pasteSentence, true, false);
            else showResult(data.url, null, false, true);
          });
        })
        .catch(function (e) { showError(e.message); })
        .finally(function () { setBusy(false); });
    }

    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", start);
    });

    return {
      start: start,
      setError: showError,
      clearError: clearError,
      controls: parts.controls,
      buttonRow: parts.row,
      result: result,
    };
  }

  window.orskoStartRoom = { mount: mount, wireCopy: wireCopy };
})();
