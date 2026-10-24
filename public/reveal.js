/*
 * Scroll reveals for the landing bands: each [data-reveal] block lands once,
 * when it comes into view, the way each element in the launch film lands on its
 * cue. Anything already on screen at load (the hero above all) is shown at once,
 * with no animation. Reduced-motion visitors get everything immediately.
 *
 * The stylesheet hides a block only once this script sets data-reveal-ready on
 * <html>, so a failed load leaves the whole page visible.
 */
(function () {
  "use strict";

  /** A block lands once its top has passed this fraction of the viewport. */
  var TRIGGER = 0.9;

  function reveal(block) {
    block.setAttribute("data-revealed", "1");
  }

  function inViewport(block) {
    var box = block.getBoundingClientRect();
    return box.top < window.innerHeight && box.bottom > 0;
  }

  function reachedTrigger(block) {
    var box = block.getBoundingClientRect();
    return box.top < window.innerHeight * TRIGGER && box.bottom > 0;
  }

  function init() {
    var blocks = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
    if (!blocks.length) return;

    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      blocks.forEach(reveal);
      return;
    }

    // On screen at load: show at once. Only what the visitor scrolls to lands.
    var pending = blocks.filter(function (block) {
      if (!inViewport(block)) return true;
      reveal(block);
      return false;
    });
    if (!pending.length) return;

    document.documentElement.setAttribute("data-reveal-ready", "1");

    // The check runs straight from the scroll handler rather than inside
    // requestAnimationFrame: a backgrounded tab never runs animation frames, and
    // a handful of getBoundingClientRect calls is cheap enough to run inline.
    function check() {
      pending = pending.filter(function (block) {
        if (!reachedTrigger(block)) return true;
        reveal(block);
        return false;
      });
      if (pending.length) return;
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      window.clearTimeout(safetyNet);
    }

    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check, { passive: true });
    // Nothing may stay invisible: whatever has not landed after a few seconds
    // (an unusual scroll container, a browser that drops the events) is shown.
    var safetyNet = window.setTimeout(function () {
      pending.forEach(reveal);
      pending = [];
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    }, 4000);
    // The replay card measures itself once its rows render, which moves every
    // block below it; re-check after that has settled.
    window.setTimeout(check, 400);
    check();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
