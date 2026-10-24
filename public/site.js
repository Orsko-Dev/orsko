/*
 * Measurement for Orsko's public pages (home, /connect, /brand, /privacy,
 * /feedback).
 *
 * Default, for every visitor and without cookies: the page view, clicks on a
 * few key buttons and links, and launch-video plays are sent to our own
 * /api/pulse endpoint. Nothing is stored in the browser for this, and the
 * server forwards scrubbed counts to Google Analytics.
 *
 * With consent only: after the visitor clicks Accept, the Google Analytics tag
 * loads (with its own page view turned off, so nothing is counted twice) and
 * may set cookies. The choice is remembered under "orsko-analytics-consent";
 * Decline also removes any Google Analytics cookies. A
 * [data-analytics-consent-reset] button (on the privacy page) reopens the
 * banner.
 *
 * Product analytics and session recordings (PostHog), for every visitor: page
 * views, clicks and recordings of these pages, with everything typed into a
 * field masked and the start-a-room result panel (it shows a fresh room link)
 * blocked. Until the visitor accepts, PostHog keeps its state in memory only, so
 * nothing is stored in the browser; Accept lets it keep an identifier that links
 * visits, and Decline drops it again. PostHog is reached through /lens on our
 * own origin (see src/http/routes/lens.ts), and loads its full bundle so the
 * recorder never has to be fetched under a name ad-block lists refuse.
 *
 * A room link is the room's only credential, so neither Google nor PostHog ever
 * sees a raw URL: /r/<id> becomes /r/:room, invite secrets are redacted, and
 * every query parameter except utm_* campaign tags is dropped. Room, sign-in and
 * account pages never load this file.
 */
(function () {
  "use strict";

  /**
   * Google Analytics and PostHog report into orsko.dev's own projects, so they
   * run only on orsko.dev. A self-hosted copy of Orsko keeps its first-party,
   * cookieless counting (through its own /api/pulse) and shows no banner.
   */
  var PRODUCTION_HOST = "orsko.dev";
  var MEASUREMENT_ID = "G-BMZS75YSKZ";
  var EVENTS_ENDPOINT = "/api/pulse";
  var CONSENT_KEY = "orsko-analytics-consent";
  var GRANTED = "granted";
  var DENIED = "denied";
  var CAMPAIGN_PARAM = /^utm_(source|medium|campaign|term|content|id)$/;
  var ROOM_PATH = /^\/r\/[^/]+/;
  var MAX_PATH_CHARS = 512;
  var MAX_REFERRER_CHARS = 2048;
  var MAX_CAMPAIGN_VALUE_CHARS = 100;

  var POSTHOG_TOKEN = "phc_o9osX9ZKYSRjJhbZzxirpezTA4kvDnCgmhMkZQ6hiw3L";
  var POSTHOG_PATH = "/lens";
  var POSTHOG_BUNDLE = POSTHOG_PATH + "/static/array.full.js";
  var POSTHOG_UI_HOST = "https://us.posthog.com";
  var PERSIST_MEMORY = "memory";
  var PERSIST_COOKIE = "localStorage+cookie";
  /** Anything shaped like a room path, anywhere in a string (hrefs, element chains, text). */
  var ROOM_PATH_ANYWHERE = /\/r\/[A-Za-z0-9_-]+/g;
  /** The same id inside API paths, e.g. /api/rooms/<id>/invites from the start-a-room flow. */
  var ROOM_API_PATH = /\/api\/rooms\/[A-Za-z0-9_-]+/g;
  /** Invite secrets and observer tokens, wherever they appear. */
  var INVITE_SECRET = /orsko_inv_[A-Za-z0-9_-]+/g;
  var OBSERVER_TOKEN = /observer=[^&#\s"']+/g;

  /** [selector, target]: the clicks worth counting. Order matters: first match wins. */
  var CLICK_TARGETS = [
    ["[data-start-room]", "start_room"],
    ["[data-have-link]", "have_link"],
    ["#copy-example", "copy_sentence"],
    ['a[href="/connect"]', "connector_link"],
    ["#copy-connector", "copy_connector"]
  ];

  var loaded = false;
  var banner = null;
  var posthogReady = false;
  /** Named events raised before the PostHog bundle has loaded. */
  var posthogQueue = [];

  /* ---------- default tier: first-party, cookieless events ---------- */

  function campaignTags() {
    var tags = null;
    new URL(window.location.href).searchParams.forEach(function (value, key) {
      if (!CAMPAIGN_PARAM.test(key) || !value) return;
      tags = tags || {};
      tags[key] = value.slice(0, MAX_CAMPAIGN_VALUE_CHARS);
    });
    return tags;
  }

  function sendEvent(name, target) {
    var body = { name: name, path: window.location.pathname.slice(0, MAX_PATH_CHARS) };
    if (target) body.target = target;
    if (name === "page_view" && document.referrer) body.referrer = document.referrer.slice(0, MAX_REFERRER_CHARS);
    var tags = campaignTags();
    if (tags) body.utm = tags;
    var payload = JSON.stringify(body);
    // A keepalive fetch first: ad-block lists target beacon (ping) requests to
    // event endpoints far more often than ordinary same-origin fetches. The
    // beacon is only the fallback for browsers without fetch.
    if (typeof fetch === "function") {
      fetch(EVENTS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
        credentials: "omit"
      }).catch(function () {
        /* Counting is best effort; a lost event never breaks the page. */
      });
      return;
    }
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(EVENTS_ENDPOINT, new Blob([payload], { type: "application/json" }));
    } catch (e) {
      /* Nothing left to count with. */
    }
  }

  function trackClicks() {
    document.addEventListener(
      "click",
      function (event) {
        var origin = event.target instanceof Element ? event.target : null;
        if (!origin) return;
        for (var i = 0; i < CLICK_TARGETS.length; i++) {
          if (origin.closest(CLICK_TARGETS[i][0])) {
            sendEvent("click", CLICK_TARGETS[i][1]);
            capturePosthog("cta_click", { target: CLICK_TARGETS[i][1] });
            return;
          }
        }
      },
      true
    );
  }

  function trackVideo() {
    var video = document.querySelector(".film video");
    if (!video) return;
    video.addEventListener(
      "play",
      function () {
        sendEvent("video_play");
        capturePosthog("video_play", {});
      },
      { once: true }
    );
  }

  /* ---------- every visitor: PostHog product analytics and recordings ---------- */

  function scrubText(value) {
    return value
      .replace(ROOM_PATH_ANYWHERE, "/r/:room")
      .replace(ROOM_API_PATH, "/api/rooms/:room")
      .replace(INVITE_SECRET, "orsko_inv_:redacted")
      .replace(OBSERVER_TOKEN, "observer=:redacted");
  }

  /** One property value, cleaned: URLs through scrub(), every string through scrubText(). */
  function scrubValue(value) {
    if (typeof value === "string") return scrubText(/^https?:\/\//.test(value) ? scrub(value) : value);
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value && typeof value === "object") return scrubProps(value);
    return value;
  }

  /** A cleaned copy of a property bag; the original is left untouched. */
  function scrubProps(props) {
    var out = {};
    Object.keys(props || {}).forEach(function (key) {
      out[key] = scrubValue(props[key]);
    });
    return out;
  }

  /**
   * Every event is cleaned before it leaves the page. Recordings ($snapshot) are
   * protected where they are captured instead: fields are masked, the room-link
   * panel is blocked, and network URLs are cleaned by maskNetworkRequest.
   */
  function beforeSend(event) {
    if (!event || event.event === "$snapshot") return event;
    var out = {};
    Object.keys(event).forEach(function (key) {
      out[key] = event[key];
    });
    out.properties = scrubProps(event.properties);
    if (event.$set) out.$set = scrubProps(event.$set);
    if (event.$set_once) out.$set_once = scrubProps(event.$set_once);
    return out;
  }

  /** Network timings in recordings carry request URLs; a room id must not ride along. */
  function maskNetworkRequest(request) {
    var out = {};
    Object.keys(request).forEach(function (key) {
      out[key] = request[key];
    });
    if (typeof request.name === "string") out.name = scrubValue(request.name);
    return out;
  }

  function capturePosthog(name, props) {
    if (window.location.hostname !== PRODUCTION_HOST) return;
    if (posthogReady) window.posthog.capture(name, props);
    else posthogQueue.push([name, props]);
  }

  function loadPosthog() {
    var script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = POSTHOG_BUNDLE;
    script.onload = function () {
      var posthog = window.posthog;
      if (!posthog || typeof posthog.init !== "function") return;
      posthog.init(POSTHOG_TOKEN, {
        api_host: window.location.origin + POSTHOG_PATH,
        ui_host: POSTHOG_UI_HOST,
        // Cookieless until the visitor accepts: state lives in memory for this page only.
        persistence: readConsent() === GRANTED ? PERSIST_COOKIE : PERSIST_MEMORY,
        person_profiles: "identified_only",
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
        disable_surveys: true,
        session_recording: {
          maskAllInputs: true,
          maskCapturedNetworkRequestFn: maskNetworkRequest
        },
        before_send: beforeSend,
        loaded: function () {
          posthogReady = true;
          posthogQueue.splice(0).forEach(function (item) {
            posthog.capture(item[0], item[1]);
          });
        }
      });
    };
    document.head.appendChild(script);
  }

  function setPosthogPersistence(persistence) {
    if (posthogReady) window.posthog.set_config({ persistence: persistence });
  }

  /** Back to memory-only, and PostHog's stored identifier is removed from cookies and storage. */
  function withdrawPosthog() {
    setPosthogPersistence(PERSIST_MEMORY);
    var name = "ph_" + POSTHOG_TOKEN + "_posthog";
    expireCookie(name);
    try {
      window.localStorage.removeItem(name);
    } catch (e) {
      /* Storage unavailable: nothing was stored there. */
    }
  }

  /* ---------- consented tier: the Google Analytics tag ---------- */

  /** The stored choice, or null when none was made (or storage is unavailable). */
  function readConsent() {
    try {
      var value = window.localStorage.getItem(CONSENT_KEY);
      return value === GRANTED || value === DENIED ? value : null;
    } catch (e) {
      return null;
    }
  }

  function storeConsent(value) {
    try {
      window.localStorage.setItem(CONSENT_KEY, value);
    } catch (e) {
      /* Storage blocked: the choice holds for this page only, and the banner asks again next time. */
    }
  }

  function clearConsent() {
    try {
      window.localStorage.removeItem(CONSENT_KEY);
    } catch (e) {
      /* Nothing stored to clear. */
    }
  }

  /** The URL with room ids collapsed; same-origin URLs keep only campaign tags. */
  function scrub(href) {
    var url;
    try {
      url = new URL(href);
    } catch (e) {
      return "";
    }
    var path = url.pathname.replace(ROOM_PATH, "/r/:room");
    if (url.origin !== window.location.origin) return url.origin + path;
    var kept = [];
    url.searchParams.forEach(function (value, key) {
      if (CAMPAIGN_PARAM.test(key)) kept.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    });
    return url.origin + path + (kept.length ? "?" + kept.join("&") : "");
  }

  /** Injects the Google Analytics tag. Reached only from a stored grant or the Accept button. */
  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    window["ga-disable-" + MEASUREMENT_ID] = false;
    var loader = document.createElement("script");
    loader.async = true;
    loader.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
    document.head.appendChild(loader);
    window.dataLayer = window.dataLayer || [];
    function gtag() {
      window.dataLayer.push(arguments);
    }
    window.gtag = gtag;
    gtag("js", new Date());
    gtag("config", MEASUREMENT_ID, {
      send_page_view: false,
      page_location: scrub(window.location.href),
      page_referrer: document.referrer ? scrub(document.referrer) : ""
    });
  }

  /**
   * Stops any further Google Analytics hits on this page and expires the cookies
   * its tag can set: _ga, _ga_* and, when the property is linked to Google Ads, _gcl_*.
   */
  function withdrawAnalytics() {
    window["ga-disable-" + MEASUREMENT_ID] = true;
    document.cookie.split(";").forEach(function (pair) {
      var name = pair.split("=")[0].trim();
      if (name !== "_ga" && name.indexOf("_ga_") !== 0 && name.indexOf("_gcl_") !== 0) return;
      expireCookie(name);
    });
  }

  /** Expires a cookie on every domain a script on this host could have set it for. */
  function expireCookie(name) {
    var host = window.location.hostname;
    var domains = ["", host, "." + host.split(".").slice(-2).join(".")];
    domains.forEach(function (domain) {
      document.cookie = name + "=; Max-Age=0; Path=/" + (domain ? "; Domain=" + domain : "");
    });
  }

  function hideBanner() {
    if (!banner) return;
    banner.remove();
    banner = null;
  }

  function choose(value) {
    storeConsent(value);
    hideBanner();
    if (value === GRANTED) {
      loadAnalytics();
      setPosthogPersistence(PERSIST_COOKIE);
    } else {
      withdrawAnalytics();
      withdrawPosthog();
    }
  }

  function choiceButton(label, className, value) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", function () {
      choose(value);
    });
    return button;
  }

  function showBanner() {
    if (banner || !document.body) return;
    banner = document.createElement("div");
    banner.className = "consent";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Analytics cookies");

    var text = document.createElement("p");
    text.className = "consent-text";
    text.appendChild(
      document.createTextNode(
        "We count visits and record how these pages are used \u2014 clicks, scrolling and screen recordings, with anything you type hidden \u2014 without cookies. Accept to let Google Analytics and PostHog set cookies that link your visits. Room and account pages are never recorded. "
      )
    );
    var link = document.createElement("a");
    link.href = "/privacy";
    link.textContent = "Privacy";
    text.appendChild(link);

    var actions = document.createElement("div");
    actions.className = "consent-actions";
    actions.appendChild(choiceButton("Decline", "btn btn-ghost btn-sm", DENIED));
    actions.appendChild(choiceButton("Accept", "btn btn-primary btn-sm", GRANTED));

    banner.appendChild(text);
    banner.appendChild(actions);
    document.body.appendChild(banner);
  }

  function bindResetControls() {
    var controls = document.querySelectorAll("[data-analytics-consent-reset]");
    Array.prototype.forEach.call(controls, function (control) {
      control.addEventListener("click", function () {
        clearConsent();
        showBanner();
      });
    });
  }

  function start() {
    sendEvent("page_view");
    trackClicks();
    trackVideo();
    if (window.location.hostname !== PRODUCTION_HOST) return;
    loadPosthog();
    bindResetControls();
    var consent = readConsent();
    if (consent === GRANTED) loadAnalytics();
    else if (consent === null) showBanner();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
