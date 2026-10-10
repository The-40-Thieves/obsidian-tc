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
function anonymousDiscoveryEnabled(auth: AuthConfig): boolean {
  return auth.anonymousDiscovery === "list" && auth.mode !== "none" && isPrmConfigured(auth);
}

/** The default scopes when mixed mode is in effect, else undefined (mode off). One value feeds both
 *  the edge gate and the `securitySchemes` of facade tools, which front tools of every scope. */
export function mixedModeScopes(auth: AuthConfig): string[] | undefined {
  return anonymousDiscoveryEnabled(auth) ? anonymousScopes(auth) : undefined;
}

/**
 * The scopes the anonymous `tools/list` is filtered by: what a caller signing in without naming a
 * scope is granted (the authorization server's own default, `auth.scopesSupported` else `read:*`).
 * So the anonymous list is exactly what a default-scope caller would see, never more.
 */
export function anonymousScopes(auth: AuthConfig): string[] {
  return resolveScopes([], auth.scopesSupported).scopes;
}

/** Anonymous means NO credentials: an absent, blank or bare-`Bearer` Authorization header. Any other
 *  value (a token, a wrong scheme) is a credential that failed, and keeps its 401. */
export function carriesNoCredentials(header: string | undefined): boolean {
  const value = header?.trim();
  return !value || value.toLowerCase() === "bearer";
}

export type AnonymousVerdict =
  | { kind: "admit" }
  | { kind: "tool-error"; id: string | number }
  | { kind: "deny" };

/**
 * Does the request ask for a push stream? The HTTP edge opens the Tasks and advisory streams from
 * `params.notifications` whatever the method is, so an admitted method carrying that key (with any
 * value) would hold a connection open for a caller nobody identified. No discovery request needs it.
 */
function asksForStream(params: unknown): boolean {
  return typeof params === "object" && params !== null && "notifications" in params;
}

/** A single JSON-RPC message only: a batch could smuggle a `tools/call` behind an allowed method. */
export function classifyAnonymous(body: unknown): AnonymousVerdict {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "deny" };
  const { method, id, params } = body as { method?: unknown; id?: unknown; params?: unknown };
  if (typeof method !== "string") return { kind: "deny" };
  if (asksForStream(params)) return { kind: "deny" };
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

/** A discovery or sign-in-trigger request is a few hundred bytes; an unauthenticated body is never
 *  buffered beyond this (the SDK's own size guard runs only after the edge has parsed it). */
const MAX_ANONYMOUS_BODY_BYTES = 64 * 1024;

async function readSmallJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ANONYMOUS_BODY_BYTES) return undefined;
  const reader = req.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANONYMOUS_BODY_BYTES) {
      // Not awaited: on a cloned (tee) body the cancel settles only once the other branch is cancelled too.
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
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
  const body = await readSmallJson(req);
  const verdict = classifyAnonymous(body);
  if (verdict.kind === "admit") return { scopes: new Set(anonymousScopes(auth)) };
  if (verdict.kind === "tool-error") {
    const modern = req.headers.get("mcp-protocol-version") === MODERN_PROTOCOL_VERSION;
    return Response.json(anonymousToolError(auth, surface, verdict.id, modern));
  }
  return undefined;
}
