// Validation of an authorization request (design v2 section 4.3, `GET /oauth/authorize`), in the
// order that decides whether the server may redirect at all. The client and the redirect URI come
// first and a failure of either is a LOCAL error: nothing has proven where the browser may be sent,
// so nothing redirects. Only after both match does any other fault become an error redirect, which
// the caller builds with `iss` and the client's `state`.
import { type ClientResolver, UNKNOWN_CLIENT } from "./as-cimd";
import type { AsClient } from "./as-clients";
import { redirectUriAllowed, resolveScopes, splitScope } from "./as-clients";
import type { PendingRequest } from "./as-grants";
import { matchResource } from "./resource-set";

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
  /** The one client lookup (static client or metadata document); see as-cimd.ts. */
  resolveClient: ClientResolver;
  /** `auth.resource`: the request may name it or any `allowedResources` member. */
  resource: string;
  scopesSupported: readonly string[] | undefined;
  /** The caller's address, for the per-source budget on metadata-document lookups. */
  source?: string | undefined;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_MAX = 512;

/** The same words for every reason a client cannot be used: which reason it is (an unreachable host, a
 *  document that is not JSON, one that names another client) is for the log, never for whoever started
 *  the sign-in, who would otherwise be told what an arbitrary URL answers. */
const CLIENT_UNUSABLE = "This client cannot be used. If it should work, try again shortly.";

interface Fault {
  error: string;
  description: string;
}

/**
 * Every check that needs nothing but the query (design v2 section 4.3 steps 3 to 6). They run BEFORE the
 * client is looked up so a request that is already wrong never starts an outbound fetch; the fault is
 * only reported (as an error redirect) once the client and redirect have proven where it may go.
 */
function queryFault(
  once: (name: string) => string | undefined | null,
  rules: AuthorizeRules,
): { fault: Fault } | { fault?: undefined; challenge: string; resource: string; scopes: string[] } {
  const state = once("state");
  if (state === null || (state !== undefined && state.length > STATE_MAX)) {
    return { fault: { error: "invalid_request", description: "state is repeated or too long" } };
  }
  const responseType = once("response_type");
  if (responseType !== "code") {
    return {
      fault: {
        error:
          responseType === null || responseType === undefined
            ? "invalid_request"
            : "unsupported_response_type",
        description: "response_type must be code",
      },
    };
  }
  const challenge = once("code_challenge");
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge)) {
    return {
      fault: {
        error: "invalid_request",
        description: "a code_challenge (S256, 43 base64url characters) is required",
      },
    };
  }
  // Only S256: `plain` and an absent method are both refused, so a downgrade is never negotiated.
  if (once("code_challenge_method") !== "S256") {
    return {
      fault: { error: "invalid_request", description: "code_challenge_method must be S256" },
    };
  }
  const asked = once("resource");
  // The audience is the member of the derived set the client named (auth/resource-set.ts), so a token
  // for /mcp/essentials carries exactly that URL.
  const resource = typeof asked === "string" ? matchResource(asked, rules.resource) : undefined;
  if (resource === undefined) {
    return {
      fault: {
        error: "invalid_target",
        description: "resource must be this server's resource URL",
      },
    };
  }
  const scope = once("scope");
  if (scope === null)
    return { fault: { error: "invalid_scope", description: "scope is repeated" } };
  const outcome = resolveScopes(splitScope(scope), rules.scopesSupported);
  if (outcome.unknown) {
    return {
      fault: {
        error: "invalid_scope",
        description: "none of the requested scopes is supported",
      },
    };
  }
  return { challenge, resource, scopes: outcome.scopes };
}

/** A redirect address that could be a client's: an absolute URL without a fragment. Nothing else is
 *  worth a lookup, and none can ever match a registered address. */
function plausibleRedirect(uri: string): boolean {
  if (uri.includes("#")) return false;
  try {
    new URL(uri);
    return true;
  } catch {
    return false;
  }
}

export async function parseAuthorizeRequest(
  q: URLSearchParams,
  rules: AuthorizeRules,
): Promise<AuthorizeOutcome> {
  const once = (name: string): string | undefined | null => {
    const all = q.getAll(name);
    return all.length > 1 ? null : all[0];
  };
  const clientId = once("client_id");
  if (clientId === null || clientId === undefined || clientId === "") {
    return { kind: "local", message: "The request does not name a client." };
  }
  const redirectUri = once("redirect_uri");
  if (redirectUri === null || redirectUri === undefined || redirectUri === "") {
    return { kind: "local", message: "The request does not name a redirect address." };
  }
  if (!plausibleRedirect(redirectUri)) {
    return { kind: "local", message: "This redirect address is not registered for the client." };
  }
  const checked = queryFault(once, rules);
  const found = await rules.resolveClient(clientId, {
    source: rules.source,
    cacheOnly: checked.fault !== undefined,
  });
  if (!("client" in found)) {
    return {
      kind: "local",
      message:
        found.failure === UNKNOWN_CLIENT ? "This client is not registered." : CLIENT_UNUSABLE,
    };
  }
  const { client } = found;
  if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
    return { kind: "local", message: "This redirect address is not registered for the client." };
  }

  const state = once("state");
  if (checked.fault !== undefined) {
    return {
      kind: "redirect",
      redirectUri,
      state: typeof state === "string" ? state.slice(0, STATE_MAX) : undefined,
      error: checked.fault.error,
      description: checked.fault.description,
    };
  }
  return {
    kind: "ok",
    client,
    request: {
      clientId: client.clientId,
      redirectUri,
      scopes: checked.scopes,
      resource: checked.resource,
      codeChallenge: checked.challenge,
      state: typeof state === "string" ? state : null,
    },
  };
}
