import {
  err,
  grantsAll,
  isMutatingScope,
  ObsidianTcError,
  scopeRequiresHitl,
} from "@the-40-thieves/obsidian-tc-shared";
import { hitlSatisfiedByState } from "../../elicit-request-state";
import { callerHash, type RateLimiter, type ThrottleDecision } from "../../throttle";
import { enforcePathAcl } from "../../vault/acl-path";
import { vaultArgOf } from "./input-binding";
import type { CallerContext, RegistryOptions, ToolDefinition, VerifyElicit } from "./types";

// WP4.3: authorization gates pulled out of registry.ts's runDispatch, unchanged in behavior. Each
// function throws the identical ObsidianTcError the inline block it replaces did; the audit/meter/
// episode reaction to a thrown error stays in dispatch.ts's single catch-all.

/** Authentication gate: a tool that declares required scopes needs an authenticated caller,
 *  independent of which scopes are actually granted (checked next by assertScopesGranted). */
export function requireAuthenticated(
  ctx: Pick<CallerContext, "authenticated">,
  def: ToolDefinition,
): void {
  if (def.requiredScopes.length > 0 && !ctx.authenticated)
    throw new ObsidianTcError("unauthorized", "authentication required for this tool");
}

/**
 * THE-514 item 1: the scope-requirement check `runDispatch`'s own scope gate (below) and
 * `resources.ts`'s readResource each wrote independently — `if (!grantsAll(...)) throw
 * forbidden(...)`. Unlike the vault-binding guard (see input-binding.ts's AUTHORITATIVE NOTE),
 * this one had no semantic divergence to preserve: same primitive (`grantsAll`), same error code,
 * same shape of `details`. It had already started to drift anyway — resources.ts's version omitted
 * `details.required`, which the "forbidden" error's own documented recovery hint
 * (`shared/src/errors.ts`) promises callers can read. One function now backs both call sites, so
 * a future change to how a missing scope is reported cannot silently apply to only one surface.
 */
export function assertScopesGranted(
  ctx: Pick<CallerContext, "grantedScopes">,
  requiredScopes: string[],
  message: string,
): void {
  if (!grantsAll(ctx.grantedScopes, requiredScopes)) {
    throw err.forbidden(message, { required: requiredScopes });
  }
}

/** Whether this call counts as MUTATING for the readOnly and vault-kind gates below — a
 *  destructive tool, or one whose required scopes include a mutating scope. Computed once by the
 *  caller and passed to both gates, matching the single `mutating` local the inline block used. */
export function isMutatingCall(
  def: Pick<ToolDefinition, "destructive" | "requiredScopes">,
): boolean {
  return def.destructive === true || def.requiredScopes.some(isMutatingScope);
}

/** A mutating call is refused outright against a read-only ACL (acl.readOnly). */
export function enforceReadOnlyGate(ctx: Pick<CallerContext, "acl">, mutating: boolean): void {
  if (mutating && ctx.acl?.readOnly)
    throw new ObsidianTcError("forbidden", "vault is read-only (acl.readOnly)");
}

/**
 * THE-569: reverse vault-kind gate. P1.5 closed the READ direction (the read:docs tools
 * refuse any vault whose kind isn't `docs`); this closes the WRITE/integrity direction — a
 * mutating call must not be able to reach a `docs`- or `system`-kind vault just because it
 * named that vault's id. Runs on the same effective vault (input.vault, falling back to
 * ctx.vaultId) the pathAcl stage resolves, so it agrees with what actually gets touched. A
 * no-op when no vaultKindResolver is wired (a registry built with no VaultRegistry, or a unit
 * test that omits it).
 */
export function enforceVaultKindGate(
  ctx: Pick<CallerContext, "vaultId">,
  def: ToolDefinition,
  data: unknown,
  mutating: boolean,
  name: string,
  vaultKindResolver: RegistryOptions["vaultKindResolver"],
): void {
  if (!vaultKindResolver || !mutating) return;
  const effVault = vaultArgOf(def, data) ?? ctx.vaultId;
  const kind = vaultKindResolver(effVault);
  if (kind === "docs" || kind === "system")
    throw err.forbidden(`${name} cannot mutate a ${kind}-kind vault`, { vault: effVault, kind });
}

/** Tool-specific precondition gate (D5). After scope/ACL, before HITL, so a rejected precheck
 *  never consumes the single-use elicit token. */
export async function runPrecheck<I>(
  def: Pick<ToolDefinition<I>, "precheck">,
  data: I,
  ctx: CallerContext,
): Promise<void> {
  if (def.precheck) await def.precheck(data, ctx);
}

/**
 * Dispatch-wide rate-limit policy gate (THE-210, G2.4 §Rate limits). Per (caller_hash,
 * scope_class, vault); an unknown scope class is unlimited. `undefined` when no rateLimiter is
 * configured — the caller then skips the gate entirely, matching the original `if
 * (this.rateLimiter)` guard. The decision itself is a pure read (TokenBucket state, not a claim);
 * the reaction to a rejected decision — metering, releasing an idempotency claim, throwing —
 * stays with the caller, since it needs dispatch-local state (idemClaimed/idemKey) this function
 * does not have.
 */
export function checkThrottle(
  rateLimiter: RateLimiter | undefined,
  caller: string | null,
  scopeClass: string,
  vaultId: string,
  nowMs: number,
): ThrottleDecision | undefined {
  if (!rateLimiter) return undefined;
  return rateLimiter.check(callerHash(caller), scopeClass, vaultId, nowMs);
}

/** Whether this tool call needs a cleared HITL (human-in-the-loop) confirmation: a destructive
 *  tool, or one whose required scopes include an HITL-floored scope. */
export function hitlRequired(def: Pick<ToolDefinition, "destructive" | "requiredScopes">): boolean {
  return def.destructive === true || def.requiredScopes.some(scopeRequiresHitl);
}

/**
 * HITL gate. A destructive/HITL-floored tool requires a valid single-use elicit token;
 * verifyElicit consumes it (UPDATE ... WHERE consumed_at IS NULL) as a SIDE EFFECT of this call
 * when it returns true — calling this twice for the same call is not safe, matching the original
 * inline check. `true` covers both the 2025 elicitToken path and THE-583's 2026-era
 * transport-verified elicitState path (hitlSatisfiedByState). The reaction to `false` (metering,
 * releasing an idempotency claim, throwing) and to `true` (relaying tc.elicit.consumed) stays with
 * the caller, since both need dispatch-local state or sinks this function does not have.
 */
export function checkHitl(
  ctx: CallerContext,
  hash: string,
  name: string,
  verifyElicit: VerifyElicit | undefined,
): boolean {
  return (
    (!!ctx.elicitToken && !!verifyElicit && verifyElicit(ctx.elicitToken, hash, ctx)) ||
    hitlSatisfiedByState(ctx.elicitState, {
      tool: name,
      argsHash: hash,
      vaultId: ctx.vaultId,
      caller: ctx.caller,
    })
  );
}

/**
 * THE-414: central folder-ACL enforcement. Extract the vault-relative paths this call touches
 * (declared per tool via def.pathAcl) and enforce the per-op ACL HERE, right before the handler —
 * so containment no longer depends on every handler remembering to call enforcePathAcl (the
 * handler-side calls remain as defense-in-depth). Uses the same symlink-canonical enforcePathAcl +
 * the (already per-vault-swapped) ctx.acl; the root is the effective vault's. A no-op when the
 * tool declares no pathAcl, or when no root resolver is wired (matching the original's nested
 * `if (def.pathAcl) { ... if (root) { ... } }`).
 */
export function enforceCentralPathAcl(
  def: ToolDefinition,
  data: unknown,
  ctx: Pick<CallerContext, "acl" | "grantedScopes" | "vaultId">,
  rootResolver: RegistryOptions["rootResolver"],
): void {
  if (!def.pathAcl) return;
  const effVault = vaultArgOf(def, data) ?? ctx.vaultId;
  const root = rootResolver?.(effVault);
  if (!root) return;
  for (const { op, path } of def.pathAcl(data)) {
    // P1.4: pass the caller's granted scopes so a path's declared rule-scopes are
    // enforced here (the authoritative central stage), not just the folder allowlist.
    enforcePathAcl(ctx.acl, op, path, root, ctx.grantedScopes);
  }
}
