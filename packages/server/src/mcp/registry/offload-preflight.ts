import { isToolDisabledFor, passesAuthorization } from "./authorization-gates";
import type { DispatchDeps } from "./dispatch";
import { parseInput } from "./input-binding";
import type { CallerContext } from "./types";
import { withDefaultVault } from "./vault-default";

/**
 * Would `runDispatch` get this call past its authorization gates? For a caller about to hand the
 * call to a background task: a call dispatch would refuse must be refused NOW, by dispatch itself
 * (which audits and meters the denial), instead of becoming a job whose failure the client
 * discovers later, or, worse, a job that runs under a context missing one of the gates' inputs.
 *
 * The gates are `runAuthorizationGates` plus the central path ACL (authorization-gates.ts): the
 * same functions dispatch runs, not a copy of its order. The rate limiter is not among them, since
 * it spends a token. It has no side effect of its own: it works on a copy of the context
 * (`applyVaultAcl` swaps `ctx.acl` in place) and claims no idempotency slot, writes no audit row.
 * A `false` is never an error to report: the caller dispatches synchronously and dispatch says why.
 */
export function passesPolicyGates(
  deps: DispatchDeps,
  name: string,
  rawInput: unknown,
  callerCtx: CallerContext,
): boolean {
  try {
    const def = deps.toolStore.get(name);
    if (!def) return false;
    if (isToolDisabledFor(deps, def, callerCtx)) return false;
    const input = parseInput(def, withDefaultVault(def, rawInput, callerCtx, deps.visibleVaultIds));
    return passesAuthorization(deps, name, def, input, callerCtx);
  } catch {
    return false;
  }
}
