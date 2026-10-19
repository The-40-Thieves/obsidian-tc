import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuthorizeUrl,
  CallbackError,
  checkCallback,
  randomToken,
  s256Challenge,
} from "./oauth.mjs";

// RFC 7636 Appendix B: the one published verifier/challenge pair.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const ENDPOINT = "https://vault.example.com/oauth/authorize";
const CALLBACK = {
  state: "st-1",
  issuer: "https://vault.example.com",
  issParameterSupported: true,
};

test("PKCE S256 challenge matches the RFC 7636 Appendix B vector", async () => {
  assert.equal(await s256Challenge(RFC_VERIFIER), RFC_CHALLENGE);
});

test("random verifier is 43 unreserved characters (RFC 7636 section 4.1)", () => {
  const verifier = randomToken();
  assert.match(verifier, /^[A-Za-z0-9._~-]{43}$/u);
  assert.notEqual(verifier, randomToken());
});

test("authorize URL carries the code flow, PKCE S256, state, client and resource", () => {
  const url = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: ENDPOINT,
      clientId: "client-1",
      redirectUri: "http://localhost:8000/index.html",
      state: "st-1",
      codeChallenge: RFC_CHALLENGE,
      resource: "https://vault.example.com/mcp",
    }),
  );
  assert.equal(url.origin + url.pathname, ENDPOINT);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8000/index.html");
  assert.equal(url.searchParams.get("state"), "st-1");
  assert.equal(url.searchParams.get("code_challenge"), RFC_CHALLENGE);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://vault.example.com/mcp");
});

test("authorize URL adds scope only when one is given", () => {
  const base = {
    authorizationEndpoint: ENDPOINT,
    clientId: "client-1",
    redirectUri: "http://localhost:8000/index.html",
    state: "st-1",
    codeChallenge: RFC_CHALLENGE,
    resource: "https://vault.example.com/mcp",
  };
  assert.equal(new URL(buildAuthorizeUrl(base)).searchParams.has("scope"), false);
  const scoped = new URL(buildAuthorizeUrl({ ...base, scope: "read:notes" }));
  assert.equal(scoped.searchParams.get("scope"), "read:notes");
});

test("callback check returns the code when state and iss match", () => {
  const params = new URLSearchParams({ code: "c-1", state: "st-1", iss: CALLBACK.issuer });
  assert.equal(checkCallback(params, CALLBACK), "c-1");
});

test("callback check rejects a state that is not the one this page sent", () => {
  const params = new URLSearchParams({ code: "c-1", state: "other", iss: CALLBACK.issuer });
  assert.throws(() => checkCallback(params, CALLBACK), CallbackError);
  const missing = new URLSearchParams({ code: "c-1", iss: CALLBACK.issuer });
  assert.throws(() => checkCallback(missing, CALLBACK), /state/u);
});

test("callback check rejects an iss that names another authorization server", () => {
  const params = new URLSearchParams({
    code: "c-1",
    state: "st-1",
    iss: "https://evil.example.com",
  });
  assert.throws(() => checkCallback(params, CALLBACK), /iss/u);
});

test("callback check rejects a missing iss when the server advertises it", () => {
  const params = new URLSearchParams({ code: "c-1", state: "st-1" });
  assert.throws(() => checkCallback(params, CALLBACK), /iss/u);
  const unadvertised = { ...CALLBACK, issParameterSupported: false };
  assert.equal(checkCallback(params, unadvertised), "c-1");
});

test("callback check reports an error from the server, after state and iss pass", () => {
  const params = new URLSearchParams({
    error: "access_denied",
    error_description: "the user said no",
    state: "st-1",
    iss: CALLBACK.issuer,
  });
  assert.throws(
    () => checkCallback(params, CALLBACK),
    (err) => err instanceof CallbackError && err.code === "access_denied",
  );
});

test("callback check rejects a redirect with neither a code nor an error", () => {
  const params = new URLSearchParams({ state: "st-1", iss: CALLBACK.issuer });
  assert.throws(() => checkCallback(params, CALLBACK), /code/u);
});
