// THE-583: the 2026-07-28 multi-round-trip shape for HITL confirmation (SEP-2260 / SEP-2322).
//
// The revision replaced server-initiated elicitation with a client-driven round trip: a handler
// answers `inputRequired({ requestState })`, the client re-issues the same call carrying that
// opaque state, and the server verifies it. `requestState` is an HMAC-signed, TTL-bounded blob —
// the server keeps nothing between rounds, which is what makes it work on a stateless transport.
//
// ⚠ REPLAY. This is a deliberate, recorded trade, not an oversight. The SDK codec authenticates and
// expires a state but does NOT consume it: an echoed value verifies repeatedly until its TTL runs
// out. The elicit_tokens table it supersedes was single-use by construction
// (`UPDATE … WHERE consumed_at IS NULL`), so within the TTL window a captured confirmation can now
// authorize the same destructive call more than once. Adopted anyway, on an explicit call, because
// the protocol shape is what a generic MCP client can actually complete — our token flow required
// bespoke client support. The TTL is the whole of the blast radius, so it is deliberately short.
//
// If one-time semantics are wanted back, the shape to add is a consumed-nonce table keyed on the
// state's `jti` checked at verify time — the wire contract below does not have to change for it.
import { createHash } from "node:crypto";
import { createRequestStateCodec } from "@modelcontextprotocol/server";

/** What a HITL confirmation is bound to. Verified against the CURRENT call before it authorizes. */
export interface ElicitRequestState {
  /** Tool the confirmation was issued for. */
  tool: string;
  /** Hash of the arguments it was issued for — approving one write must not authorize another. */
  argsHash: string;
  /** Vault the confirmation belongs to; a state from one vault must not spend in another. */
  vaultId: string;
  /** Caller the confirmation was issued to, when the transport knows one. */
  caller: string | null;
  /** THE-1106 fix round 2: how many times a round trip has already been offered for this ORIGINAL
   *  call chain — 1 on the first offer, incremented on each re-offer after a human APPROVED but
   *  the state didn't match what actually needed confirming (e.g. a handler-side gate the
   *  dispatch-level state doesn't cover). `mcp/elicit-form.ts`'s `offerInputRequired` refuses to
   *  mint past a small cap, so a persistent mismatch fails closed with a FEW prompts, not the
   *  SDK shim's full `maxRounds` (8) — an actual decline/cancel is a separate, unrelated stop
   *  condition (`roundDeclinedOrCancelled`) and never reaches this counter. Absent/`undefined`
   *  reads as round 0 (pre-THE-1106-fix-round-2 states, and the very first offer). */
  round?: number;
}

/**
 * Derive the codec key from the server's JWT secret.
 *
 * Hashed rather than used directly, for two reasons: the codec requires >= 32 bytes and a
 * configured `jwtSecret` may be shorter, and reusing one secret verbatim for two purposes means a
 * flaw in either primitive touches both. The domain-separation string makes this a distinct key
 * derived from the same root, so rotating the secret rotates outstanding confirmations too — which
 * is the behaviour you want from a rotation.
 */
export function deriveRequestStateKey(jwtSecret: string): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(`${jwtSecret}|obsidian-tc/elicit-request-state`).digest(),
  );
}

export interface ElicitCodec {
  mint: (payload: ElicitRequestState) => Promise<string>;
  verify: (state: string) => Promise<ElicitRequestState>;
  /** THE-1106 fix round 2 (LOW 1): the TTL this codec was built with, in seconds — read back by
   *  `createMcpServer` so the SDK legacy shim's per-leg `roundTimeoutMs` can be capped to it. The
   *  shim's own default (600s) is LONGER than the codec's default TTL (300s): a human who answers
   *  between 300s and 600s completes the leg fine, but the re-entered handler's `requestState
   *  .verify` then rejects the now-EXPIRED state with a raw `-32602`, not a clean re-offer.
   *  Capping the leg timeout to the TTL makes the SHIM itself time the leg out first, producing
   *  its own clean `isError` failure (the existing `elicit_required` text/fallback path) instead. */
  ttlSeconds: number;
}

/**
 * Build the HITL request-state codec. `ttlSeconds` mirrors the elicit-token TTL it replaces so the
 * configured confirmation window is unchanged by the migration.
 */
export function createElicitCodec(jwtSecret: string, ttlSeconds: number): ElicitCodec {
  return {
    ...(createRequestStateCodec({
      key: deriveRequestStateKey(jwtSecret),
      ttlSeconds,
    }) as unknown as Omit<ElicitCodec, "ttlSeconds">),
    ttlSeconds,
  };
}

/**
 * Does a verified state authorize THIS call?
 *
 * Every field is compared. A state is a capability, and one scoped to a different tool, different
 * arguments, a different vault or a different caller is not a confirmation of what is about to
 * run — accepting any of those would turn one approval into a general-purpose one.
 */
export function stateAuthorizes(
  state: ElicitRequestState,
  call: { tool: string; argsHash: string; vaultId: string; caller: string | null },
): boolean {
  return (
    state.tool === call.tool &&
    state.argsHash === call.argsHash &&
    state.vaultId === call.vaultId &&
    state.caller === call.caller
  );
}

/**
 * Does a caller context already carry a confirmation good for this call?
 *
 * Lives here rather than inline in the dispatch gate so the decision is unit-testable without
 * standing up a registry — and so `registry.ts` stays under its line cap, which is the reason it
 * was extracted rather than the reason it should be.
 */
export function hitlSatisfiedByState(
  state: ElicitRequestState | undefined,
  call: { tool: string; argsHash: string; vaultId: string; caller: string | null },
): boolean {
  return state !== undefined && stateAuthorizes(state, call);
}
