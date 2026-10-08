// Validation of an authorization request (design v2 section 4.3, `GET /oauth/authorize`), in the
// order that decides whether the server may redirect at all. The client and the redirect URI come
// first and a failure of either is a LOCAL error: nothing has proven where the browser may be sent,
// so nothing redirects. Only after both match does any other fault become an error redirect, which
// the caller builds with `iss` and the client's `state`.
import type { AsClient } from "./as-clients";
import { redirectUriAllowed, resolveScopes, sameResource, splitScope } from "./as-clients";
import type { PendingRequest } from "./as-grants";

export type AuthorizeOutcome =
  | { kind: "local"; message: string }
  | {
      kind: "redirect";
      redirectUri: string;
      state: string | undefined;
      error: string;
      description: string;
    }
  | { kind: "ok"; client: AsClient; request: PendingRequest };

export interface AuthorizeRules {
  findClient: (clientId: string) => AsClient | undefined;
  resource: string;
  scopesSupported: readonly string[] | undefined;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_MAX = 512;

export function parseAuthorizeRequest(q: URLSearchParams, rules: AuthorizeRules): AuthorizeOutcome {
  const once = (name: string): string | undefined | null => {
    const all = q.getAll(name);
    return all.length > 1 ? null : all[0];
  };
  const clientId = once("client_id");
  if (clientId === null || clientId === undefined || clientId === "") {
    return { kind: "local", message: "The request does not name a client." };
  }
  const client = rules.findClient(clientId);
  if (client === undefined) return { kind: "local", message: "This client is not registered." };
  const redirectUri = once("redirect_uri");
  if (redirectUri === null || redirectUri === undefined || redirectUri === "") {
    return { kind: "local", message: "The request does not name a redirect address." };
  }
  if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
    return { kind: "local", message: "This redirect address is not registered for the client." };
  }

  const state = once("state");
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: "redirect",
    redirectUri,
    state: typeof state === "string" ? state.slice(0, STATE_MAX) : undefined,
    error,
    description,
  });
  if (state === null || (state !== undefined && state.length > STATE_MAX)) {
    return fail("invalid_request", "state is repeated or too long");
  }
  const responseType = once("response_type");
  if (responseType !== "code") {
    return fail(
      responseType === null || responseType === undefined
        ? "invalid_request"
        : "unsupported_response_type",
      "response_type must be code",
    );
  }
  const challenge = once("code_challenge");
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge)) {
    return fail("invalid_request", "a code_challenge (S256, 43 base64url characters) is required");
  }
  // Only S256: `plain` and an absent method are both refused, so a downgrade is never negotiated.
  if (once("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  const resource = once("resource");
  if (typeof resource !== "string" || !sameResource(resource, rules.resource)) {
    return fail("invalid_target", "resource must be this server's resource URL");
  }
  const scope = once("scope");
  if (scope === null) return fail("invalid_scope", "scope is repeated");
  const outcome = resolveScopes(splitScope(scope), rules.scopesSupported);
  if (outcome.unknown) return fail("invalid_scope", "none of the requested scopes is supported");

  return {
    kind: "ok",
    client,
    request: {
      clientId: client.clientId,
      redirectUri,
      scopes: outcome.scopes,
      resource: rules.resource,
      codeChallenge: challenge,
      state: typeof state === "string" ? state : null,
    },
  };
}
