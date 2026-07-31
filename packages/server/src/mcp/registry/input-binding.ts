import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";

// WP4.3: input binding, pulled out of registry.ts's runDispatch UNCHANGED. Covers the three gates
// that decide WHICH vault and WHOSE ACL the rest of dispatch runs under, before any authorization
// decision is made against that vault: the input-schema parse, the THE-267 vault-binding guard, and
// the THE-295 per-vault ACL swap. Each function throws (or mutates ctx) exactly as the inline block
// it replaces did; the audit/meter/episode reaction to a thrown error stays in dispatch.ts, which
// already has a single catch-all for every stage.

/** THE-513 Part 2: the caller-supplied target vault id for this call, read from the tool's
 *  declared `vaultArg` field (defaulting to "vault", the name every tool used before this field
 *  existed) — the single place every call site below resolves it, instead of each hardcoding
 *  `.vault` on the parsed input. */
export function vaultArgOf(def: ToolDefinition, data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[def.vaultArg ?? "vault"];
  return typeof v === "string" ? v : undefined;
}

/** Input-schema validation stage: the first thing runDispatch does, before auth/scope/ACL. */
export function parseInput<I>(def: ToolDefinition<I, unknown>, rawInput: unknown): I {
  const parsed = def.inputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ObsidianTcError("validation_error", "input validation failed", {
      issues: parsed.error.issues,
    });
  return parsed.data;
}

/**
 * Vault-binding guard (THE-267). A vault-bound caller (an HTTP token) may act only on its
 * own vault: the ~90 vault tools resolve a caller-supplied `vault` arg against ANY configured
 * vault under the single global ACL, so without this a token reaches every vault. resources/read
 * already enforces the same invariant. Fires only when a `vault` arg is present, so the execute
 * family (no vault arg) and vault-omitting calls are unaffected; trusted stdio is unbound.
 *
 * THE-514 item 2 — AUTHORITATIVE NOTE on the one place this guard's condition differs from
 * resources.ts's readResource (its `if (vaultId !== ctx.vaultId)` check, which points back
 * here): this check is CONDITIONAL on `ctx.vaultBound === true`, so a trusted stdio caller
 * (vaultBound left unset) may still name any configured vault. readResource's equivalent
 * check is UNCONDITIONAL — it refuses `vaultId !== ctx.vaultId` regardless of vaultBound, so
 * even a trusted stdio caller reading a resource is pinned to its own vault.
 *
 * Same concern (don't let a caller reach a vault it isn't bound to), two behaviours, and this
 * is a DELIBERATE, EVALUATED divergence, not an oversight:
 *   - Tools stay conditional because trusted stdio operators routinely address every
 *     configured vault by name through the `vault` argument (prefetch, admin tools, multi-vault
 *     workflows) — that is the documented meaning of "trusted": no HTTP token, no vaultBound.
 *   - resources/read stays unconditional because listResources only ever emits URIs for
 *     ctx.vaultId (mcp/resources.ts's listResources) — there is no legitimate reason for ANY caller,
 *     trusted or not, to construct a foreign-vault resource URI by hand, so the narrower rule
 *     costs a trusted caller nothing while closing off a hand-crafted URI as an attack surface.
 * The divergence is currently in the SAFE direction (resources is the stricter of the two). If
 * this is ever revisited, that is a security-semantics decision — evaluate it explicitly rather
 * than "fixing" one side to match the other; see the parity gate in
 * dispatch-parity.test.ts ("vault-binding: documented divergence, asserted as such"), which
 * asserts this documented state rather than sameness.
 */
export function enforceVaultBinding(ctx: CallerContext, def: ToolDefinition, data: unknown): void {
  if (ctx.vaultBound !== true) return;
  const requested = vaultArgOf(def, data);
  if (requested !== undefined && requested !== ctx.vaultId)
    throw new ObsidianTcError("forbidden", "vault is not the caller's bound vault", {
      vault: requested,
      bound_vault: ctx.vaultId,
    });
}

/**
 * THE-295: per-vault ACL. When the parsed input names a vault, the remainder of this dispatch
 * (the readOnly gate + every enforcePathAcl in the handler) runs under THAT vault's ACL — the
 * root ACL is the inherited default. Runs AFTER the THE-267 vault-binding guard, so a bound
 * caller cannot reach another vault's ACL. The advertised tool surface (listVisible) deliberately
 * keeps the caller's default ACL; enforcement is per-vault here at dispatch. Mutates `ctx.acl`
 * (property mutation, not param reassignment — ctx objects are per-dispatch), matching the
 * original inline block exactly.
 */
export function applyVaultAcl(
  ctx: CallerContext,
  def: ToolDefinition,
  data: unknown,
  aclResolver: RegistryOptions["aclResolver"],
): void {
  if (!aclResolver) return;
  const requestedVault = vaultArgOf(def, data);
  if (requestedVault === undefined) return;
  const vaultAcl = aclResolver(requestedVault);
  if (vaultAcl) (ctx as { acl?: typeof vaultAcl }).acl = vaultAcl;
}
