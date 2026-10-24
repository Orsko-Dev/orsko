/* The sign-in page: posts the email address as JSON and shows the
   "check your inbox" state. Never says whether an address is known. */
(function () {
  "use strict";
  var form = document.getElementById("email-form");
  var input = document.getElementById("email-input");
  var submit = document.getElementById("email-submit");
  var error = document.getElementById("email-error");
  var card = document.getElementById("signin-card");
  var sent = document.getElementById("sent-card");
  var signinError = document.getElementById("signin-error");
  if (!form || !input || !submit || !error || !card || !sent) return;

  // GitHub sign-in failures land back here as `/signin?error=<code>` (the
  // GET /auth/github routes redirect instead of answering JSON when the
  // request came from a browser). Show the message, then drop the query
  // parameter so a reload or a copied link doesn't repeat it.
  var ERROR_COPY = {
    auth_unavailable: "Sign-in is not configured on this deployment yet.",
    invalid_request: "That sign-in link is not valid. Try again.",
  };

  function showSigninError(code) {
    if (!signinError) return;
    signinError.textContent = ERROR_COPY[code] || "Sign-in failed. Try again.";
  }

  (function readErrorFromQuery() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("error");
    if (!code) return;
    showSigninError(code);
    params.delete("error");
    var query = params.toString();
    var url = window.location.pathname + (query ? "?" + query : "") + window.location.hash;
    window.history.replaceState(null, "", url);
  })();

  function fail(message) {
    error.textContent = message;
    submit.disabled = false;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    error.textContent = "";
    var email = input.value.trim();
    if (!email || email.indexOf("@") < 1) {
      fail("Enter a valid email address.");
      return;
    }
    submit.disabled = true;
    fetch("/auth/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: email }),
    })
      .then(function (res) {
        if (res.status === 202) {
          card.classList.add("hidden");
          sent.classList.remove("hidden");
          sent.focus();
          return;
        }
        if (res.status === 429) {
          fail("Too many sign-in emails from here. Try again in a few minutes.");
          return;
        }
        if (res.status === 503) {
          fail("Sign-in is temporarily unavailable.");
          return;
        }
        fail("Enter a valid email address.");
      })
      .catch(function () {
        fail("Network error. Try again.");
      });
  });
})();
