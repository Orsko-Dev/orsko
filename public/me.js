/* The history page: the rooms this account created or joined, with filter
   tabs, stacked member avatars, and keyset paging. */
(function () {
  "use strict";

  /** How many member avatars a row shows before it collapses the rest. */
  var MAX_AVATARS = 4;

  function el(id) {
    return document.getElementById(id);
  }

  function node(tag, className, textContent) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (textContent !== undefined) n.textContent = textContent;
    return n;
  }

  function formatDate(ms) {
    return ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "unknown";
  }

  // Avatars are generated locally by avatar.js; a page loaded before the
  // module is ready simply renders names without them.
  function avatarSvgFor(roomId, member) {
    if (!window.orskoAvatar) return null;
    if (member.role === "observer") return window.orskoAvatar.observerAvatarFor(member.name, roomId).svg;
    return window.orskoAvatar.avatarFor(member.name, roomId).svg;
  }

  function avatarStack(room) {
    var stack = node("div", "avatar-stack");
    var shown = room.members.slice(0, MAX_AVATARS);
    shown.forEach(function (member) {
      var slot = node("span", "avatar-slot");
      slot.title = member.name;
      var svg = avatarSvgFor(room.roomId, member);
      if (svg) slot.innerHTML = svg;
      else slot.textContent = member.name.slice(0, 2);
      stack.appendChild(slot);
    });
    if (room.members.length > shown.length) {
      stack.appendChild(node("span", "avatar-more", "+" + (room.members.length - shown.length)));
    }
    if (room.members.length === 0) stack.appendChild(node("span", "muted small", "no members yet"));
    return stack;
  }

  function roomRow(room) {
    var li = node("li", "room-row");
    li.appendChild(avatarStack(room));

    var main = node("div", "room-main");
    var title = node("div", "room-title");
    title.appendChild(node("span", null, room.purpose || room.roomId));
    title.appendChild(node("span", "badge", room.state));
    if (room.private) title.appendChild(node("span", "badge", "private"));
    main.appendChild(title);
    main.appendChild(
      node(
        "div",
        "room-meta muted small",
        room.yourRole + "  ·  created " + formatDate(room.createdAt) + "  ·  active " + formatDate(room.lastActivityAt),
      ),
    );
    li.appendChild(main);

    var open = node("a", "btn btn-ghost btn-sm", "Open");
    open.href = room.url;
    li.appendChild(open);
    return li;
  }

  function fetchJson(url) {
    return fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          return { status: res.status, body: body };
        });
    });
  }

  function init() {
    var signedOut = el("signed-out-card");
    var app = el("history-app");
    var list = el("history-list");
    var empty = el("history-empty");
    var error = el("history-error");
    var more = el("load-more");
    var tabs = document.querySelectorAll("[data-filter]");
    if (!signedOut || !app || !list) return;

    var filter = "all";
    var cursor = null;

    function load(append) {
      var url = "/api/me/rooms?filter=" + encodeURIComponent(filter);
      if (append && cursor) url += "&cursor=" + encodeURIComponent(cursor);
      return fetchJson(url).then(function (res) {
        if (res.status === 401) {
          signedOut.hidden = false;
          app.hidden = true;
          return;
        }
        signedOut.hidden = true;
        app.hidden = false;
        if (res.status !== 200 || !res.body) {
          error.textContent = "Could not load your rooms.";
          return;
        }
        error.textContent = "";
        if (!append) list.textContent = "";
        res.body.rooms.forEach(function (room) {
          list.appendChild(roomRow(room));
        });
        cursor = res.body.nextCursor;
        // Inline display, not a class: `.btn` sets its own display and would
        // otherwise win over a `.hidden` rule declared earlier in the sheet.
        more.style.display = cursor ? "inline-flex" : "none";
        empty.classList.toggle("hidden", list.childElementCount > 0);
      });
    }

    // A room created here belongs at the top of the list, so the panel's
    // result hands straight back to a fresh first page.
    function refresh() {
      cursor = null;
      return load(false);
    }

    // Signed-out visitors never see this: the whole block lives inside
    // #history-app, which stays hidden until the list loads.
    if (window.orskoStartRoom) {
      window.orskoStartRoom.mount(el("start-room"), {
        compact: true,
        hideControlsOnResult: false,
        onResult: refresh,
      });
    }

    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener("click", function () {
        Array.prototype.forEach.call(tabs, function (other) {
          other.classList.toggle("is-active", other === tab);
        });
        filter = tab.getAttribute("data-filter");
        cursor = null;
        load(false);
      });
    });

    if (more) {
      more.addEventListener("click", function () {
        load(true);
      });
    }

    load(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
