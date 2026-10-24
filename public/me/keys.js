/* The API keys page: lists a signed-in user's personal keys, creates new
   ones (shown once), and revokes existing ones. */
(function () {
  "use strict";

  function el(id) {
    return document.getElementById(id);
  }

  function text(node, value) {
    node.textContent = value;
  }

  function formatDate(ms) {
    return ms ? new Date(ms).toLocaleString() : "never";
  }

  // A small local copy of app.js's wireCopy: this page does not otherwise
  // depend on app.js, which carries room- and landing-page-specific code.
  function copyText(value, btn) {
    function flash() {
      var original = btn.textContent;
      text(btn, "Copied");
      setTimeout(function () {
        text(btn, original);
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(flash, function () {
        // Clipboard write can be denied by the browser; the key stays
        // selectable in the reveal box either way.
      });
    }
  }

  function fetchJson(url, init) {
    return fetch(url, Object.assign({ credentials: "same-origin" }, init)).then(function (res) {
      return res.json().catch(function () {
        return null;
      }).then(function (body) {
        return { status: res.status, body: body };
      });
    });
  }

  function init() {
    var signedOut = el("signed-out-card");
    var app = el("keys-app");
    var list = el("keys-list");
    var empty = el("keys-empty");
    var form = el("create-form");
    var labelInput = el("label-input");
    var submit = el("create-submit");
    var createError = el("create-error");
    var revealCard = el("reveal-card");
    var revealText = el("reveal-key-text");
    var copyBtn = el("copy-key");
    if (!signedOut || !app || !list || !form) return;

    function renderKeys(keys) {
      list.textContent = "";
      empty.classList.toggle("hidden", keys.length > 0);
      keys.forEach(function (k) {
        var li = document.createElement("li");
        li.className = "key-row";

        var main = document.createElement("div");
        var label = document.createElement("div");
        label.className = "key-label";
        text(label, k.label);
        var meta = document.createElement("div");
        meta.className = "key-meta muted small";
        text(
          meta,
          k.prefix +
            "…  ·  created " +
            formatDate(k.createdAt) +
            "  ·  last used " +
            formatDate(k.lastUsedAt),
        );
        main.appendChild(label);
        main.appendChild(meta);
        li.appendChild(main);

        if (k.revokedAt) {
          var revoked = document.createElement("span");
          revoked.className = "badge";
          text(revoked, "revoked");
          li.appendChild(revoked);
        } else {
          var revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "btn btn-ghost btn-sm";
          text(revoke, "Revoke");
          revoke.addEventListener("click", function () {
            if (!window.confirm('Revoke the key "' + k.label + '"? This cannot be undone.')) return;
            revoke.disabled = true;
            fetchJson("/api/me/keys/" + k.id, {
              method: "DELETE",
              headers: { "content-type": "application/json" },
            }).then(function (res) {
              if (res.status === 204) return loadKeys();
              revoke.disabled = false;
            });
          });
          li.appendChild(revoke);
        }
        list.appendChild(li);
      });
    }

    function loadKeys() {
      return fetchJson("/api/me/keys").then(function (res) {
        if (res.status !== 200) {
          signedOut.hidden = false;
          app.hidden = true;
          return;
        }
        signedOut.hidden = true;
        app.hidden = false;
        renderKeys((res.body && res.body.keys) || []);
      });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var label = labelInput.value.trim();
      createError.textContent = "";
      if (!label) {
        createError.textContent = "A label is required.";
        return;
      }
      submit.disabled = true;
      fetchJson("/api/me/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label }),
      })
        .then(function (res) {
          if (res.status === 201) {
            labelInput.value = "";
            text(revealText, res.body.key);
            revealCard.classList.remove("hidden");
            revealCard.focus();
            return loadKeys();
          }
          if (res.status === 409) {
            createError.textContent =
              "You are at the limit of active keys. Revoke one first.";
            return;
          }
          if (res.status === 429) {
            createError.textContent = "Too many keys created recently. Try again later.";
            return;
          }
          createError.textContent = "Could not create a key.";
        })
        .finally(function () {
          submit.disabled = false;
        });
    });

    if (copyBtn && revealText) {
      copyBtn.addEventListener("click", function () {
        copyText(revealText.textContent, copyBtn);
      });
    }

    loadKeys();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
