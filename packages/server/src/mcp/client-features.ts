// THE-583: the three server->client features the 2026-07-28 revision DEPRECATED but did not remove
// — Logging, Roots and Sampling (SEP-2577, >=12-month functional window).
//
// Wired because the SDK still implements all three at runtime (`sendLoggingMessage`, `listRoots`,
// `createMessage`) and a deprecation window is exactly the period in which a client may still use
// them. Deprecated is not gone; a server that ignores them is unusable to a client that has not
// migrated yet.
//
// Every one of these is a request the SERVER makes of the CLIENT, which makes capability
// negotiation load-bearing rather than decorative: calling any of them against a client that never
// advertised support is a protocol error, not a soft failure. So each helper here is gated on the
// capability first and returns `undefined` when it is absent — an absent optional feature is a
// normal state, not an error to propagate into a tool call.
//
// STATELESSNESS. Under Streamable HTTP this server is built per request, so anything a client
// negotiates lives exactly as long as one call. That is fine for emitting — a notification belongs
// to the request that produced it — and it is why the verbosity floor is fixed rather than settable:
// `logging/setLevel` is unroutable under the MODERN (2026-07-28) era — SEP-2575 removed the method,
// and the modern route refuses it by name (-32601) before any `Server` handler runs, measured by
// protocol-2026-conformance.test.ts. It is NOT refused under LEGACY (2025-11-25) on this SDK
// version: declaring the `logging: {}` capability (server.ts) makes the SDK's own `Server`
// constructor auto-register a built-in `logging/setLevel` handler, reachable under legacy because
// nothing pre-filters the method the way the modern route does — it SUCCEEDS, returning `{}`. That
// success is harmless: the level it stores is keyed by `transportSessionId` and never consulted,
// because this transport is stateless and that session key never comes back. See
// docs/MCP-CLIENT-COMPAT-MATRIX.md (Finding 2, THE-725/THE-862) and
// mcp-client-compat-matrix.test.ts for both eras asserted from code.
import type { Server } from "@modelcontextprotocol/server";

/** The RFC 5424 levels the spec defines, ordered least to most severe. */
export const LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Is `level` at or above `minimum`? Used to honour a client's requested verbosity. */
export function meetsLevel(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}

/** Narrowing helper: a capability object declares `key` when it is a present object. */
function declares(caps: unknown, key: string): boolean {
  return (
    caps !== null &&
    typeof caps === "object" &&
    (caps as Record<string, unknown>)[key] !== null &&
    typeof (caps as Record<string, unknown>)[key] === "object"
  );
}

/**
 * The SDK's PER-REQUEST log sink (`extra.mcpReq.log`), threaded from the handler that owns `extra`.
 *
 * Undefined for any caller constructing a server directly (stdio, tests): logging is an optional
 * client-facing feature, and its absence is a normal state rather than an error.
 */
export type RequestLog = (level: LogLevel, data: unknown, logger?: string) => Promise<void>;

/**
 * Emit a `notifications/message` for THIS request, if the client asked for logging on it.
 *
 * The gate is the whole reason this is a per-request sink. SEP-2575 removed `logging/setLevel` and
 * made verbosity a per-request `_meta` field, then made the consequence normative: a server
 * **MUST NOT** emit `notifications/message` for a request that did not carry
 * `io.modelcontextprotocol/logLevel`.
 *
 * That check lives in the SDK's `mcpReq.log`, which reads the request envelope and returns silently
 * when the field is absent. It is NOT in `server.sendLoggingMessage` — that path is deprecated and
 * filters against a SESSION-keyed level, which a stateless server never populates, so it emits to
 * clients that never asked. Using it here was a MUST NOT violation that looked correct: the
 * notification went out, nothing threw, and the level filter appeared to be doing the work.
 *
 * No `minimum` parameter any more, deliberately. The threshold is the CLIENT's, carried on the
 * request; a server-side floor would only re-filter what the SDK already filtered — against the
 * wrong number.
 *
 * Never throws. A transport that has already gone away (the client hung up mid-call) must not turn
 * into a failed tool call — that would make observability the thing that breaks the request it was
 * observing.
 */
export async function emitLog(
  log: RequestLog | undefined,
  message: { level: LogLevel; logger: string; data: unknown },
): Promise<void> {
  if (log === undefined) return;
  try {
    await log(message.level, message.data, message.logger);
  } catch {
    /* the client is gone, or never enabled logging — diagnostics must not fail the call */
  }
}

/**
 * Ask the client for its filesystem roots (deprecated by SEP-2577, still served).
 *
 * Returns `undefined` when the client did not advertise `roots`, which is the overwhelmingly common
 * case and not an error. Our vaults come from config and are NOT derived from this — a client
 * naming a root does not grant access to it. It is advisory context only, which is the whole reason
 * consuming it is safe.
 */
export async function clientRoots(
  server: Server,
): Promise<Array<{ uri: string; name?: string }> | undefined> {
  const caps = (
    server as unknown as { getClientCapabilities: () => unknown }
  ).getClientCapabilities();
  if (!declares(caps, "roots")) return undefined;
  try {
    const res = await (
      server as unknown as {
        listRoots: () => Promise<{ roots?: Array<{ uri: string; name?: string }> }>;
      }
    ).listRoots();
    return res.roots ?? [];
  } catch {
    return undefined;
  }
}

/** Did the client advertise sampling — i.e. can this server ask it to run a completion? */
export function clientSupportsSampling(server: Server): boolean {
  return declares(
    (server as unknown as { getClientCapabilities: () => unknown }).getClientCapabilities(),
    "sampling",
  );
}

/**
 * Ask the CLIENT's model for a completion (deprecated by SEP-2577, still served).
 *
 * Deliberately NOT a fallback for the LiteLLM gateway. The gateway is chosen, configured and
 * budgeted by the operator; the client's model is whatever the caller happens to be running. Making
 * one silently substitute for the other would move inference — and its cost and data exposure — to
 * a party the operator never selected. Exposed so a caller can opt into it explicitly, and returns
 * `undefined` when unsupported rather than falling back to anything.
 */
export async function sampleViaClient(
  server: Server,
  params: { messages: unknown[]; maxTokens: number; systemPrompt?: string },
): Promise<unknown | undefined> {
  if (!clientSupportsSampling(server)) return undefined;
  try {
    return await (
      server as unknown as { createMessage: (p: unknown) => Promise<unknown> }
    ).createMessage(params);
  } catch {
    return undefined;
  }
}
