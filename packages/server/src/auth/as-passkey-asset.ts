// The browser half of the passkeys (design v2 section 4.11.3), served at `/oauth/assets/passkey.js`
// under `script-src 'self'`. It is a string in the module because `bun --compile` ships no assets
// (the reason migrations are embedded too), and it is written against the browser's own WebAuthn JSON
// API (`PublicKeyCredential.parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON`, `toJSON()`,
// all in the three engines since 2025), so it needs no library and loads nothing from anywhere else.
// A browser without that API leaves the page exactly as it was: password only.
//
// The page hands it three facts through data attributes on `#passkey` (the CSP forbids inline
// script): the mode, the form token and, at login, the pending authorization request.
export const AS_PASSKEY_JS = `"use strict";
(function () {
  var mount = document.getElementById("passkey");
  var button = document.getElementById("passkey-button");
  var status = document.getElementById("passkey-status");
  var supported =
    mount && window.PublicKeyCredential &&
    typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function" &&
    typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function";
  if (!supported) return;

  var csrf = mount.getAttribute("data-csrf") || "";
  var request = mount.getAttribute("data-request") || undefined;

  function say(text) {
    if (status) status.textContent = text;
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(
        function (json) { return { ok: res.ok, status: res.status, body: json }; },
        function () { return { ok: false, status: res.status, body: {} }; }
      );
    });
  }

  function login(conditional, signal) {
    return post("/oauth/passkey/login/options").then(function (opts) {
      if (!opts.ok) throw new Error("options");
      return navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts.body),
        mediation: conditional ? "conditional" : "optional",
        signal: signal
      });
    }).then(function (credential) {
      if (!credential) return;
      return post("/oauth/passkey/login/verify", {
        response: credential.toJSON(),
        request: request
      }).then(function (done) {
        if (!done.ok || typeof done.body.redirect !== "string" || done.body.redirect.indexOf("/oauth/") !== 0) {
          throw new Error("refused");
        }
        window.location.assign(done.body.redirect);
      });
    });
  }

  function enroll() {
    say("");
    return post("/oauth/passkey/register/options").then(function (opts) {
      if (opts.status === 403) throw new Error("stale");
      if (!opts.ok) throw new Error("options");
      return navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts.body)
      });
    }).then(function (credential) {
      if (!credential) return;
      return post("/oauth/passkey/register/verify", { response: credential.toJSON() }).then(function (done) {
        if (!done.ok) throw new Error("refused");
        window.location.reload();
      });
    });
  }

  function failure(err) {
    if (err && err.name === "AbortError") return;
    if (err && err.name === "NotAllowedError") return say("Cancelled.");
    if (err && err.message === "stale") return say("Sign out and sign in again first.");
    say(mount.getAttribute("data-mode") === "enroll"
      ? "The passkey was not added."
      : "The passkey was not accepted. Use the username and password.");
  }

  if (mount.getAttribute("data-mode") === "enroll") {
    if (button) {
      button.hidden = false;
      button.addEventListener("click", function () { enroll().catch(failure); });
    }
    return;
  }

  // Sign-in: offer the passkey through the username field's autofill (conditional UI) and, where
  // that is missing, through the button.
  var pending = null;
  function start(conditional) {
    if (pending) pending.abort();
    pending = new AbortController();
    return login(conditional, pending.signal);
  }
  if (button) {
    button.hidden = false;
    button.addEventListener("click", function () { start(false).catch(failure); });
  }
  var conditionalAvailable = typeof PublicKeyCredential.isConditionalMediationAvailable === "function"
    ? PublicKeyCredential.isConditionalMediationAvailable()
    : Promise.resolve(false);
  conditionalAvailable.then(function (yes) {
    if (yes) start(true).catch(failure);
  });
})();
`;
