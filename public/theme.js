/* The three-state theme control in the nav: system, light, dark.
   The choice is stored in localStorage and applied by setting data-theme on
   <html>; the inline script in every page head applies the stored choice
   before first paint, so the page never flashes the other ground. */
(function () {
  "use strict";

  var KEY = "orsko-theme";
  var MODES = [
    ["system", "Sys", "Follow the system theme"],
    ["light", "Light", "Light theme"],
    ["dark", "Dark", "Dark theme"],
  ];

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : "system";
    } catch (e) {
      return "system";
    }
  }

  function persist(mode) {
    try {
      if (mode === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (e) {
      /* a browser that refuses storage still gets the theme for this page */
    }
  }

  function apply(mode) {
    var root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
  }

  function render(slot) {
    var current = stored();
    var group = document.createElement("div");
    group.className = "theme-control";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Theme");

    var buttons = MODES.map(function (mode) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = mode[1];
      button.title = mode[2];
      button.setAttribute("aria-label", mode[2]);
      button.setAttribute("aria-pressed", String(mode[0] === current));
      button.addEventListener("click", function () {
        current = mode[0];
        apply(current);
        persist(current);
        buttons.forEach(function (other, i) {
          other.setAttribute("aria-pressed", String(MODES[i][0] === current));
        });
      });
      group.appendChild(button);
      return button;
    });

    slot.textContent = "";
    slot.appendChild(group);
  }

  function init() {
    apply(stored());
    var slot = document.getElementById("nav-theme");
    if (slot) render(slot);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
