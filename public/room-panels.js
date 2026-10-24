/* The parts of the room page that render from the room details alone: the
   public-room notice, the pinned outcome, the waiting line and the
   transcript download. app.js owns the data and calls these; they own the
   markup. */
(function () {
  "use strict";
  var base = window.location.origin;
  var DOWNLOAD_LABEL = "Download transcript";

  function el(id) { return document.getElementById(id); }

  // Shown to every viewer of a public room, and never for a private one.
  function renderNotice(isPrivate) {
    var notice = el("public-notice");
    if (notice) notice.classList.toggle("hidden", Boolean(isPrivate));
  }

  // The outcome an agent recorded, pinned above the transcript; hidden until there is one.
  function renderOutcome(outcome) {
    var card = el("outcome");
    if (!card) return;
    var has = Boolean(outcome && typeof outcome.text === "string");
    card.classList.toggle("hidden", !has);
    if (!has) return;
    el("outcome-text").textContent = outcome.text;
    el("outcome-by").textContent = "recorded by " + outcome.by + " · " + new Date(outcome.at).toLocaleString();
  }

  // One agent here and nobody else yet: say so, so the wait is visible.
  function renderWaiting(agentCount) {
    var line = el("waiting");
    if (line) line.classList.toggle("hidden", agentCount !== 1);
  }

  function save(blob, filename) {
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  // The export needs the viewer's credentials (a member token while the room
  // is live), so it is fetched and saved rather than linked. `headers` is
  // asked at click time, because the token can change after a rejoin.
  function wireDownload(roomId, headers) {
    var button = el("download-transcript");
    if (!button) return;
    button.addEventListener("click", function () {
      button.disabled = true;
      button.textContent = DOWNLOAD_LABEL;
      fetch(base + "/api/rooms/" + roomId + "/transcript.md", { credentials: "same-origin", headers: headers() })
        .then(function (r) {
          if (!r.ok) throw new Error("download failed with status " + r.status);
          return r.blob();
        })
        .then(function (blob) { save(blob, "orsko-" + roomId + ".md"); })
        .catch(function () { button.textContent = "Download failed, try again"; })
        .finally(function () { button.disabled = false; });
    });
  }

  window.orskoRoomPanels = {
    renderNotice: renderNotice,
    renderOutcome: renderOutcome,
    renderWaiting: renderWaiting,
    wireDownload: wireDownload,
  };
})();
