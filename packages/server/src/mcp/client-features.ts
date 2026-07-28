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
// `logging/setLevel` is not a routable method in SDK v2 (absent from both wire registries; a handler
// registered for it answers -32601, measured), and it could not persist between calls even if it
// were.
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
 * Emit a `notifications/message` to the connected client, if it asked for logging at this level.
 *
 * Never throws. A log line is diagnostic output, and a transport that has already gone away (the
 * common case: the client hung up mid-call) must not turn into a failed tool call — that would make
 * observability the thing that breaks the request it was observing.
 */
export async function emitLog(
  server: Server,
  minimum: LogLevel,
  message: { level: LogLevel; logger: string; data: unknown },
): Promise<void> {
  if (!meetsLevel(message.level, minimum)) return;
  try {
    await (
      server as unknown as {
        sendLoggingMessage: (m: unknown) => Promise<void>;
      }
    ).sendLoggingMessage(message);
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
