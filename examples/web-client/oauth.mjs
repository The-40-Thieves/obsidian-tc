// PKCE (RFC 7636), the authorization request URL and the redirect check (RFC 6749 section 4.1.2,
// RFC 9207 `iss`). No DOM and no network, so `node --test` runs these directly and the page
// imports the same functions.

const encoder = new TextEncoder();

/** base64url without padding (RFC 4648 section 5). */
export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** 32 random bytes encode to 43 unreserved characters, the RFC 7636 minimum verifier length. */
export function randomToken(byteLength = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** The S256 code challenge: BASE64URL(SHA-256(ASCII(verifier))). */
export async function s256Challenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The authorization request: code flow, PKCE S256, the client's state and the RFC 8707 resource. */
export function buildAuthorizeUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  resource,
  scope,
}) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  if (scope) url.searchParams.set("scope", scope);
  return url;
}

export class CallbackError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "CallbackError";
    this.code = code;
  }
}

/**
 * Checks the query of the redirect back from the authorization server and returns the code.
 * `state` and `iss` are checked before the `error` parameter is reported, so an error response
 * that was not started by this page is refused like any other forged redirect.
 */
export function checkCallback(params, { state, issuer, issParameterSupported }) {
  if (params.get("state") !== state) {
    throw new CallbackError("state does not match the sign-in this page started");
  }
  const iss = params.get("iss");
  if (iss !== null && iss !== issuer) {
    throw new CallbackError("iss does not name the authorization server this page used");
  }
  if (issParameterSupported && iss === null) {
    throw new CallbackError("iss is missing, but the authorization server advertises it");
  }
  const error = params.get("error");
  if (error !== null) {
    throw new CallbackError(params.get("error_description") ?? error, { code: error });
  }
  const code = params.get("code");
  if (!code) throw new CallbackError("the redirect carries no authorization code");
  return code;
}
