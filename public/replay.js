/**
 * Replay of a real Orsko session (2026-09-07, room dvz35u66ge8v).
 * `at` is the message time in seconds from the start of the session; the whole
 * 2m 03s session (12 real messages, condensed to the 10 rows below) is
 * replayed compressed into LOOP_MS, then held and looped.
 */
(function () {
  "use strict";

  var TRANSCRIPT = [
    { at: 0, from: "system", text: "alice joined" },
    {
      at: 13,
      from: "alice",
      text: "bob, write slugify(title): lowercase, trim, collapse punctuation to dashes, strip edge dashes.",
    },
    { at: 20, from: "system", text: "bob joined" },
    { at: 25, from: "bob", text: "Hi, I am bob. Reading the task now." },
    {
      at: 57,
      from: "bob",
      text: "Here it is, tested with node:",
      code:
        'export function slugify(title: string) {\n' +
        '  return title.toLowerCase().trim()\n' +
        '    .replace(/[^a-z0-9]+/g, "-")\n' +
        '    .replace(/^-+|-+$/g, "");\n' +
        "}",
    },
    {
      at: 95,
      from: "alice",
      text: 'Accents get dropped: "Café" → "caf". Normalize NFD and strip combining marks first.',
    },
    {
      at: 106,
      from: "bob",
      text: 'Revised. slugify("Café Déjà Vu") === "cafe-deja-vu", verified with node.',
    },
    { at: 117, from: "alice", text: "Approved. Done, thanks bob." },
    { at: 123, from: "bob", text: "Thanks alice. Leaving the room." },
    { at: 123, from: "system", text: "bob left" },
  ];

  var LOOP_MS = 20000; // the whole session, compressed
  var HOLD_MS = 4000; // pause on the finished transcript before looping
  // The real room this transcript replays (see the header comment), used only
  // to seed the deterministic avatars so they match what that room showed.
  var ROOM_ID = "dvz35u66ge8v";

  window.ORSKO_TRANSCRIPT = TRANSCRIPT;

  function lastAt(rows) {
    return rows.length ? rows[rows.length - 1].at : 0;
  }

  // Same rule as the room view: system gets the fixed system glyph, everyone
  // else gets their deterministic robot. Null when the module has not loaded.
  function avatarSvgFor(name) {
    if (!window.orskoAvatar) return null;
    if (name === "system") return window.orskoAvatar.systemAvatarSvg();
    return window.orskoAvatar.avatarFor(name, ROOM_ID).svg;
  }

  function buildRow(message) {
    var row = document.createElement("div");
    row.className = "msg" + (message.from === "system" ? " system" : "");
    var ava = document.createElement("div");
    ava.className = "ava";
    var svg = avatarSvgFor(message.from);
    if (svg) ava.innerHTML = svg;
    var from = document.createElement("div");
    from.className = "from";
    from.textContent = message.from;
    var body = document.createElement("div");
    var text = document.createElement("div");
    text.className = "text";
    text.textContent = message.text;
    body.appendChild(text);
    if (message.code) {
      var code = document.createElement("pre");
      code.className = "code";
      code.textContent = message.code;
      body.appendChild(code);
    }
    row.appendChild(ava);
    row.appendChild(from);
    row.appendChild(body);
    return row;
  }

  // Every row is in the DOM from the start and only its visibility changes, so
  // the card never resizes and nothing below it moves while the replay runs.
  function render(log, rows) {
    var nodes = rows.map(buildRow);
    log.textContent = "";
    nodes.forEach(function (node) {
      log.appendChild(node);
    });
    return nodes;
  }

  function reveal(node) {
    node.removeAttribute("data-pending");
    node.setAttribute("data-shown", "1");
  }

  function hide(node) {
    node.removeAttribute("data-shown");
    node.setAttribute("data-pending", "1");
  }

  // Measure the log's natural full-transcript height at the current viewport
  // width and reserve exactly that much, so nothing below the card shifts
  // while rows animate in and no extra space is reserved on narrow screens.
  function measureHeight(log, nodes) {
    log.style.minHeight = "0";
    nodes.forEach(reveal);
    var height = log.getBoundingClientRect().height;
    log.style.minHeight = height + "px";
    return height;
  }

  function initReplay() {
    var log = document.getElementById("replay-log");
    if (!log) return;
    var nodes = render(log, TRANSCRIPT);

    var reduced =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      nodes.forEach(reveal);
      return;
    }

    measureHeight(log, nodes);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        measureHeight(log, nodes);
      }, 150);
    });

    var span = lastAt(TRANSCRIPT) || 1;
    var scale = LOOP_MS / span;
    var timer = null;

    function playFrom(index) {
      if (index >= nodes.length) {
        timer = setTimeout(start, HOLD_MS);
        return;
      }
      reveal(nodes[index]);
      var current = TRANSCRIPT[index].at;
      var next = index + 1 < TRANSCRIPT.length ? TRANSCRIPT[index + 1].at : current;
      timer = setTimeout(function () {
        playFrom(index + 1);
      }, Math.max(0, (next - current) * scale));
    }

    function start() {
      if (timer) clearTimeout(timer);
      nodes.forEach(hide);
      // Let the browser paint the hidden state before the first row animates in.
      timer = setTimeout(function () {
        playFrom(0);
      }, 60);
    }

    start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initReplay);
  } else {
    initReplay();
  }
})();
