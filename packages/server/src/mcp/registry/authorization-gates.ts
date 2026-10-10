// The authorization gates of a tool call, in the one order both `runDispatch` and the offload
// pre-flight (offload-preflight.ts) apply them.
//
// They used to be two hand-copied lists. The pre-flight's stopped at the vault-kind gate while
// dispatch went on to the central path ACL, so a call dispatch would refuse as `acl_denied` was
// queued as a task and its denial surfaced later and unaudited. Giving both the same function is
// the fix: a gate added or reordered here moves for both, and test/task-offload-policy.test.ts
// holds the two to the same verdict on every kind of refusal.
//
// Everything here is free of side effects beyond `applyVaultAcl`'s swap of `ctx.acl` (a caller
// that must not be touched passes a copy). The rate limiter, idempotency, HITL and the handler are
// stateful and stay in dispatch, which applies them between these gates and the path ACL.
import { type EffectiveToolVisibilityConfig, isDisabled } from "../visibility";
import { applyVaultAcl, enforceVaultBinding } from "./input-binding";
import {
  assertScopesGranted,
  enforceCentralPathAcl,
  enforceReadOnlyGate,
  enforceVaultKindGate,
  isMutatingCall,
  type ResolvedPolicy,
  requireAuthenticated,
  resolveOperationPolicy,
} from "./policy-gates";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";
import { withEffectiveVault } from "./vault-default";

/**
 * What the gates read of the registry's construction-time config. A subset of `DispatchDeps`
 * (which satisfies it), declared here so this module does not import dispatch.ts back.
 */
export interface AuthorizationDeps {
  toolVisibility: EffectiveToolVisibilityConfig;
  aclResolver?: RegistryOptions["aclResolver"];
  rootResolver?: RegistryOptions["rootResolver"];
  vaultKindResolver?: RegistryOptions["vaultKindResolver"];
}

/** Is `def` removed from this caller's surface (config, scopes, read-only ACL, persona mask)? */
export function isToolDisabledFor(
  deps: Pick<AuthorizationDeps, "toolVisibility">,
  def: ToolDefinition,
  ctx: CallerContext,
): boolean {
  return isDisabled(def, deps.toolVisibility, {
    grantedScopes: ctx.grantedScopes,
    readOnly: ctx.acl?.readOnly,
    toolVisibility: ctx.toolVisibility,
  });
}

/** The named stages of `runAuthorizationGates`, for a caller that traces them. */
export type AuthorizationStage = "auth_check" | "policy_eval" | "read_only" | "vault_kind";

export interface AuthorizedCall {
  /** The context the rest of the call runs under: `vaultId` is the vault the call acts on. */
  ctx: CallerContext;
  policy: ResolvedPolicy;
  mutating: boolean;
}

/**
 * Authentication, scopes, vault binding, per-vault ACL, read-only and vault-kind, in dispatch's
 * order, on an already-parsed `input`. Throws the refusal; returns the context and policy to carry
 * on with. `observe` is told which stage is about to run and what is known by then (dispatch uses
 * it for its trace spans and error telemetry), and must not throw.
 */
export function runAuthorizationGates(
  deps: AuthorizationDeps,
  name: string,
  def: ToolDefinition,
  input: unknown,
  callerCtx: CallerContext,
  observe?: (stage: AuthorizationStage, state: AuthorizedCall) => void,
): AuthorizedCall {
  let ctx = callerCtx;
  // THE-727: authorization is a property of the CALL, not only of the tool, so the policy is
  // resolved from the parsed input before any gate that consumes it.
  const policy = resolveOperationPolicy(def, input);
  const mutating = isMutatingCall(policy);
  observe?.("auth_check", { ctx, policy, mutating });
  requireAuthenticated(ctx);
  assertScopesGranted(ctx, policy.requiredScopes, "missing required scope(s)");

  observe?.("policy_eval", { ctx, policy, mutating });
  enforceVaultBinding(ctx, def, input);
  applyVaultAcl(ctx, def, input, deps.aclResolver);
  // From here on `ctx.vaultId` is the effect vault (binding, the one reader of the caller's own
  // vaultId, has run): the HITL error/mint/redeem, idempotency, audit and metrics all follow it.
  ctx = withEffectiveVault(ctx, def, input);

  observe?.("read_only", { ctx, policy, mutating });
  enforceReadOnlyGate(ctx, mutating, name, deps.toolVisibility);
  observe?.("vault_kind", { ctx, policy, mutating });
  enforceVaultKindGate(ctx, def, input, mutating, name, deps.vaultKindResolver);
  return { ctx, policy, mutating };
}

/**
 * Would every authorization gate dispatch applies admit this call, the central path ACL included?
 * Pure: no rate-limit token, no idempotency claim, no audit row, and `callerCtx` is not modified.
 *
 * Dispatch applies the path ACL last, after its stateful gates; here nothing stateful runs, so it
 * follows the shared gates directly. A `resolveTarget` tool names its target only at dispatch, so
 * its ACL cannot be evaluated here and the answer is no (it then takes the synchronous path).
 */
export function passesAuthorization(
  deps: AuthorizationDeps,
  name: string,
  def: ToolDefinition,
  input: unknown,
  callerCtx: CallerContext,
): boolean {
  if (def.resolveTarget) return false;
  try {
    const { ctx } = runAuthorizationGates(deps, name, def, input, { ...callerCtx });
    enforceCentralPathAcl(def, input, ctx, deps.rootResolver);
    return true;
  } catch {
    return false;
  }
}
