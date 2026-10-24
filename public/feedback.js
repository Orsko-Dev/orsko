/* The feedback page: posts one note to /api/feedback and shows the thank-you
   state. It works signed out; the page the visitor came from travels with the
   note only in its scrubbed form, which the server collapses again. */
(function () {
  "use strict";
  var MAX = 2000;
  var form = document.getElementById("feedback-form");
  var message = document.getElementById("feedback-message");
  var contact = document.getElementById("feedback-contact");
  var submit = document.getElementById("feedback-submit");
  var count = document.getElementById("feedback-count");
  var error = document.getElementById("feedback-error");
  var card = document.getElementById("feedback-card");
  var sent = document.getElementById("feedback-sent");
  var again = document.getElementById("feedback-again");
  if (!form || !message || !contact || !submit || !count || !error || !card || !sent) return;

  function updateCount() {
    var left = MAX - message.value.length;
    count.textContent = left + (left === 1 ? " character left" : " characters left");
  }

  /* Where the visitor came from, with room ids collapsed before it leaves the
     browser. The server scrubs it again; this keeps the link out of the
     request in the first place. */
  function referringPage() {
    var referrer = document.referrer;
    if (!referrer) return undefined;
    var url;
    try {
      url = new URL(referrer);
    } catch (e) {
      return undefined;
    }
    if (url.origin !== window.location.origin) return undefined;
    return url.pathname.replace(/^\/r\/[^/]+/, "/r/:room");
  }

  function fail(text) {
    error.textContent = text;
    submit.disabled = false;
  }

  function messageFor(status, body) {
    if (status === 422) {
      return (body && body.error && body.error.message)
        ? "That note looks like it contains a credential: " + body.error.message
        : "That note looks like it contains a credential. Redact it and send again.";
    }
    if (status === 429) return "That is a lot of feedback from here. Try again a little later.";
    if (status === 400) return "That note could not be sent. Check the address and try again.";
    return "Feedback is temporarily unavailable. Try again later.";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    error.textContent = "";
    var text = message.value.trim();
    if (!text) {
      fail("Write a note first.");
      return;
    }
    var address = contact.value.trim();
    if (address && address.indexOf("@") < 1) {
      fail("Enter a valid email address, or leave it blank.");
      return;
    }
    var body = { message: text };
    if (address) body.contact = address;
    var page = referringPage();
    if (page) body.page = page;
    submit.disabled = true;
    fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (res.status === 204) {
          card.classList.add("hidden");
          sent.classList.remove("hidden");
          sent.focus();
          return;
        }
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (parsed) {
            fail(messageFor(res.status, parsed));
          });
      })
      .catch(function () {
        fail("Network error. Try again.");
      });
  });

  if (again)
    again.addEventListener("click", function () {
      message.value = "";
      contact.value = "";
      updateCount();
      sent.classList.add("hidden");
      card.classList.remove("hidden");
      message.focus();
    });

  message.addEventListener("input", updateCount);
  updateCount();
})();
