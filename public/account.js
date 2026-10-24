/* Shared nav account state: fills #nav-account with a Sign in link or the
   signed-in user's avatar and menu. Loaded by every page. */
(function () {
  "use strict";

  /* The API keys page is built and served, but hidden from the account menu
     until keys become a user-facing feature. Flip to true to restore it. */
  const SHOW_API_KEYS = false;

  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function signInLink() {
    var a = el("a", "btn btn-ghost btn-sm", "Sign in");
    a.href = "/signin";
    return a;
  }

  /* One uppercase letter for the fallback tile: the display name if it has
     one, else the email's local part. Neither is guaranteed to start with a
     letter (an all-emoji name, a numeric-looking local part), so scan for
     the first one and fall back to a neutral glyph rather than render
     nothing. */
  function initialFor(user) {
    var basis = user.displayName || (user.email ? user.email.split("@")[0] : "") || "";
    var match = /[A-Za-z]/.exec(basis);
    return match ? match[0].toUpperCase() : "•";
  }

  /* Rendered in place of the avatar image when the user has no avatarUrl,
     and swapped in by the image's onerror handler when a GitHub avatar URL
     goes dead. Square (unlike the round image) and sized to match it. */
  function avatarFallback(user) {
    var tile = el("span", "account-avatar-fallback", initialFor(user));
    tile.setAttribute("aria-hidden", "true");
    return tile;
  }

  function signOut() {
    return fetch("/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
    }).then(function () {
      window.location.reload();
    });
  }

  function accountMenu(user) {
    var name = user.displayName || user.email;
    var wrap = el("details", "account-menu");
    var summary = el("summary", "account-summary");
    /* Below 640px the visible name steps aside (see .account-name in
       style.css) so the lockup keeps its 44px nav height; this aria-label is
       what carries the user's name into the accessible name at every width,
       since it always wins over the summary's text content. */
    summary.setAttribute("aria-label", name + " account menu");
    if (user.avatarUrl) {
      var img = el("img", "account-avatar");
      img.src = user.avatarUrl;
      img.alt = "";
      img.width = 22;
      img.height = 22;
      img.addEventListener("error", function () {
        img.replaceWith(avatarFallback(user));
      });
      summary.appendChild(img);
    } else {
      summary.appendChild(avatarFallback(user));
    }
    summary.appendChild(el("span", "account-name", name));
    wrap.appendChild(summary);

    var list = el("div", "account-links");
    var history = el("a", null, "History");
    history.href = "/me";
    var out = el("button", "linklike", "Sign out");
    out.type = "button";
    out.addEventListener("click", function () {
      signOut();
    });
    list.appendChild(history);
    if (SHOW_API_KEYS) {
      var keys = el("a", null, "API keys");
      keys.href = "/me/keys";
      list.appendChild(keys);
    }
    list.appendChild(out);
    wrap.appendChild(list);
    return wrap;
  }

  function render(slot, user) {
    slot.textContent = "";
    slot.appendChild(user ? accountMenu(user) : signInLink());
  }

  function load() {
    var slot = document.getElementById("nav-account");
    if (!slot) return Promise.resolve(null);
    return fetch("/api/me", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (body) {
        var user = body && body.user ? body.user : null;
        render(slot, user);
        return user;
      })
      .catch(function () {
        render(slot, null);
        return null;
      });
  }

  window.orskoAccount = { load: load, signOut: signOut };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      load();
    });
  } else {
    load();
  }
})();
