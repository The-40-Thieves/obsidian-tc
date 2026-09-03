// THE-934: defence-in-depth layer over the plane's generative seam (Gate 2, Option A). Fix round 1
// moved the PRIMARY enforcement to the two ports (gateway/client.ts's createGatewayClient,
// embeddings/index.ts's createEmbeddingProvider(Async)) -- every `GatewayClient`/`EmbeddingProvider`
// the server ever constructs is guarded there unconditionally, so a consumer cannot obtain an
// unguarded handle at all. `guardGatewayRoles` below is kept for the shape that still needs it: a
// `GatewayRoles` object NOT built from a guarded `GatewayClient` (a test fake, or a future adapter
// this module cannot foresee) can still opt into the same check. Round 0's assemblers
// (contradiction/synthesis/citation) still filter their own candidates BEFORE building a request --
// that is the chokepoint; this and the port guards are the backstop that catches what a filtering
// bug or a forgotten call site misses.
import { assertSourcePathsAllowed, type EgressFilter, EgressViolationError } from "./egress-filter";
import type { GatewayCompletionRequest, GatewayRoles } from "./gateway";

export { EgressViolationError };

function guardRequest(
  filter: EgressFilter,
  role: "extract" | "synthesize" | "judge",
  req: GatewayCompletionRequest,
): void {
  assertSourcePathsAllowed(filter, role, req.sourcePaths);
}

/** Wrap a GatewayRoles so every extract/synthesize/judge call is checked against the egress
 *  filter before it reaches the real gateway. Pass-through when `filter` excludes nothing
 *  (patterns.length === 0): the sourcePaths requirement is unconditional either way (Gate 2's
 *  fail-closed intent -- a caller that never declares what it is sending is a bug regardless of
 *  whether any exclusion is configured today). See `assertSourcePathsAllowed` for the exact
 *  undefined-vs-empty-array semantics (fixed in fix round 1 -- I1). */
export function guardGatewayRoles(roles: GatewayRoles, filter: EgressFilter): GatewayRoles {
  // Each wrapper is `async` deliberately, not a plain arrow returning `roles.xxx(req)` — a plain
  // arrow would let guardRequest's throw happen SYNCHRONOUSLY when the caller invokes .judge(...),
  // before it ever becomes a Promise, which every caller here (they all `await`, per GatewayRoles'
  // Promise-returning contract) would see as an uncaught exception rather than a rejection.
  return {
    extract: async (req) => {
      guardRequest(filter, "extract", req);
      return roles.extract(req);
    },
    synthesize: async (req) => {
      guardRequest(filter, "synthesize", req);
      return roles.synthesize(req);
    },
    judge: async (req) => {
      guardRequest(filter, "judge", req);
      return roles.judge(req);
    },
  };
}
