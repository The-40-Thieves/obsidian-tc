import {
  err,
  grantsAll,
  isMutatingScope,
  ObsidianTcError,
} from "@the-40-thieves/obsidian-tc-shared";
import { vaultArgOf } from "./input-binding";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";

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
