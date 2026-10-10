// `auth.anonymousDiscovery: "list"` (ChatGPT "OAuth or no authentication" mixed mode): the ONE place
// that decides what a request carrying no token at all may do. The HTTP edge (http.ts) asks
// `classifyAnonymous` only when the Authorization header held no bearer token; a request with a bad
// token never gets here, so an expired token still earns the 401 that makes a client refresh.
//
// Default (`none`) never reaches this file: every request without a token is a 401 with the
// WWW-Authenticate challenge, which is what grok.com needs to start its sign-in (it does so only
// when `tools/list` answers 401).
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { resolveScopes } from "../auth/as-clients";
import { isPrmConfigured, wwwAuthenticateToolChallenge } from "../auth/protected-resource";
import { MODERN_PROTOCOL_VERSION } from "../mcp/tasks";

type AuthConfig = ServerConfig["auth"];

/**
 * Methods an anonymous caller may reach the MCP handler with: the lifecycle (`initialize`,
 * `notifications/initialized`, `ping`, the 2026-07-28 `server/discover`) and `tools/list`, which is
 * ChatGPT's discovery. Nothing else: resources, prompts, tasks and subscriptions read or hold
 * caller state, and `tools/call` is answered by `anonymousToolError`, never dispatched.
 */
const ANONYMOUS_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "server/discover",
  "tools/list",
]);

/** The mode is effective only with a complete Protected Resource Metadata: without it the challenge
 *  carries no `resource_metadata` and ChatGPT has nothing to link from, so fall back to the 401. */
export function anonymousDiscoveryEnabled(auth: AuthConfig): boolean {
  return auth.anonymousDiscovery === "list" && auth.mode !== "none" && isPrmConfigured(auth);
}

/**
 * The scopes the anonymous `tools/list` is filtered by: what a caller signing in without naming a
 * scope is granted (the authorization server's own default, `auth.scopesSupported` else `read:*`).
 * So the anonymous list is exactly what a default-scope caller would see, never more.
 */
export function anonymousScopes(auth: AuthConfig): string[] {
  return resolveScopes([], auth.scopesSupported).scopes;
}

export type AnonymousVerdict =
  | { kind: "admit" }
  | { kind: "tool-error"; id: string | number }
  | { kind: "deny" };

/** A single JSON-RPC message only: a batch could smuggle a `tools/call` behind an allowed method. */
export function classifyAnonymous(body: unknown): AnonymousVerdict {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "deny" };
  const { method, id } = body as { method?: unknown; id?: unknown };
  if (typeof method !== "string") return { kind: "deny" };
  if (ANONYMOUS_METHODS.has(method)) return { kind: "admit" };
  if (method === "tools/call" && (typeof id === "string" || typeof id === "number"))
    return { kind: "tool-error", id };
  return { kind: "deny" };
}

/**
 * The JSON-RPC response to an anonymous `tools/call`: an `isError` tool result whose
 * `_meta["mcp/www_authenticate"]` holds the challenge the 401 would carry for this URL, which is
 * what makes ChatGPT open its account-linking UI. `resultType` is the 2026-07-28 discriminator.
 */
export function anonymousToolError(
  auth: AuthConfig,
  surface: string | undefined,
  id: string | number,
  modern: boolean,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      ...(modern ? { resultType: "complete" } : {}),
      content: [{ type: "text", text: "Authentication required: no access token provided." }],
      isError: true,
      _meta: { "mcp/www_authenticate": [wwwAuthenticateToolChallenge(auth, surface)] },
    },
  };
}

/**
 * The gate for a request that carried no bearer token (mixed mode only). Returns the scopes to admit
 * it with (discovery), a ready Response (an anonymous `tools/call`), or undefined to let the 401
 * stand: an unparsable body, a batch, or any method outside the allowed set.
 */
export async function anonymousGate(
  req: Request,
  auth: AuthConfig,
  surface: string | undefined,
): Promise<Response | { scopes: Set<string> } | undefined> {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return undefined;
  }
  const verdict = classifyAnonymous(body);
  if (verdict.kind === "admit") return { scopes: new Set(anonymousScopes(auth)) };
  if (verdict.kind === "tool-error") {
    const modern = req.headers.get("mcp-protocol-version") === MODERN_PROTOCOL_VERSION;
    return Response.json(anonymousToolError(auth, surface, verdict.id, modern));
  }
  return undefined;
}
