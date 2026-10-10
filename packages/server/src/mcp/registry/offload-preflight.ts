import { isDisabled } from "../visibility";
import type { DispatchDeps } from "./dispatch";
import { applyVaultAcl, enforceVaultBinding, parseInput } from "./input-binding";
import {
  assertScopesGranted,
  enforceReadOnlyGate,
  enforceVaultKindGate,
  isMutatingCall,
  requireAuthenticated,
  resolveOperationPolicy,
} from "./policy-gates";
import type { CallerContext } from "./types";
import { withDefaultVault, withEffectiveVault } from "./vault-default";

/**
 * Would `runDispatch` get this call past its policy gates? For a caller about to hand the call to a
 * background task: a call dispatch would refuse must be refused NOW, by dispatch itself (which
 * audits and meters the denial), instead of becoming a job whose failure the client discovers later,
 * or, worse, a job that runs under a context missing one of the gates' inputs.
 *
 * It runs the same gate functions in the same order as `runDispatch`, up to the first one with a
 * side effect (the rate limiter), so the two cannot drift apart on what a gate means. It has no side
 * effect of its own: it works on a copy of the context (`applyVaultAcl` swaps `ctx.acl` in place)
 * and spends no token, claims no idempotency slot, writes no audit row. A `false` is never an
 * error to report: the caller dispatches synchronously and dispatch says why.
 */
export function passesPolicyGates(
  deps: DispatchDeps,
  name: string,
  rawInput: unknown,
  callerCtx: CallerContext,
): boolean {
  let ctx: CallerContext = { ...callerCtx };
  try {
    const def = deps.toolStore.get(name);
    if (!def) return false;
    if (
      isDisabled(def, deps.toolVisibility, {
        grantedScopes: ctx.grantedScopes,
        readOnly: ctx.acl?.readOnly,
        toolVisibility: ctx.toolVisibility,
      })
    )
      return false;
    const input = parseInput(def, withDefaultVault(def, rawInput, ctx, deps.visibleVaultIds));
    const policy = resolveOperationPolicy(def, input);
    requireAuthenticated(ctx);
    assertScopesGranted(ctx, policy.requiredScopes, "missing required scope(s)");
    enforceVaultBinding(ctx, def, input);
    applyVaultAcl(ctx, def, input, deps.aclResolver);
    ctx = withEffectiveVault(ctx, def, input);
    const mutating = isMutatingCall(policy);
    enforceReadOnlyGate(ctx, mutating, name, deps.toolVisibility);
    enforceVaultKindGate(ctx, def, input, mutating, name, deps.vaultKindResolver);
    return true;
  } catch {
    return false;
  }
}
