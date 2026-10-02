import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";

// Omitted-`vault` default. A tool's `vault` is a required `VaultId` in its input schema; when
// exactly one vault is VISIBLE to the caller (token binding + the vault's own folder ACL, see
// vault/visible-vaults.ts) the caller has nothing to choose, so dispatch fills it in BEFORE the
// schema parse. Done once here rather than per tool, so every tool and every facade mode
// (flat/triad/domain/call_capability all end in registry.dispatch) gets it, and handlers keep
// seeing a plain `string` vault.
//
// Fail-closed shape: nothing is filled when zero or several vaults are visible, so those calls fail
// the schema parse exactly as before and vaultFailureHint lists only the visible ids. A caller-
// supplied `vault` is never touched, so enforceVaultBinding and the per-vault gates run on it as
// they always did; a filled one is by construction the caller's own visible vault.

/** The one phrase every advertised `vault` property carries. Short: it repeats on every tool. */
export const VAULT_OMITTABLE_HINT = "Vault id. May be omitted when only one vault is available.";

interface SchemaNode {
  def?: { type?: string; innerType?: SchemaNode };
  shape?: Record<string, SchemaNode>;
}

/** The object schema at the root of a tool's input, through any optional/default wrapper. */
function rootObject(schema: unknown): SchemaNode | undefined {
  let s = schema as SchemaNode | undefined;
  for (let guard = 0; guard < 8 && s?.def?.innerType; guard++) s = s.def.innerType;
  return s?.shape ? s : undefined;
}

/** True when `key` is a REQUIRED field of the tool's top-level input object and is the shared
 *  `VaultId` primitive itself (reference-identical, the same test vault-arg-coverage uses). An
 *  already-optional vault, a `vault` that is some other string, and a tool with no such field are
 *  all left exactly as declared. */
export function isOmittableVaultArg(schema: unknown, key: string): boolean {
  return rootObject(schema)?.shape?.[key] === (VaultId as unknown);
}

/** The input to validate: `rawInput`, with the visible vault filled into an absent vault argument
 *  when there is exactly one. Returns `rawInput` itself (same reference) in every other case. */
export function withDefaultVault(
  def: ToolDefinition,
  rawInput: unknown,
  ctx: CallerContext,
  visibleVaultIds: RegistryOptions["visibleVaultIds"],
): unknown {
  const key = def.vaultArg ?? "vault";
  if (!isOmittableVaultArg(def.inputSchema, key)) return rawInput;
  if (rawInput !== undefined && (rawInput === null || typeof rawInput !== "object"))
    return rawInput;
  if (Array.isArray(rawInput)) return rawInput;
  const args = (rawInput ?? {}) as Record<string, unknown>;
  if (args[key] !== undefined) return rawInput;
  // No resolver wired (a registry built without a VaultRegistry): only a bound caller has a vault
  // the server itself vouches for; an unbound one is left to the schema.
  const visible = visibleVaultIds
    ? visibleVaultIds(ctx)
    : ctx.vaultBound === true
      ? [ctx.vaultId]
      : [];
  const only = visible.length === 1 ? visible[0] : undefined;
  return only === undefined ? rawInput : { ...args, [key]: only };
}

/** The caller context a call runs under: `ctx` with `vaultId` set to the vault the call ACTS ON (the
 *  parsed vault argument, explicit or defaulted) when that differs from the caller's own. Everything
 *  keyed on a per-call vault (the elicit_required text and mint command, token mint/redeem, audit,
 *  idempotency claim, rate-limit bucket, metrics) reads `ctx.vaultId`, so it must name the effect
 *  vault, never the stdio first-vault placeholder. Call only AFTER enforceVaultBinding, which needs
 *  the caller's own `vaultId`. Returns `ctx` itself when nothing differs, so the common case keeps
 *  one context object; a copy otherwise, which leaves a shared caller context untouched. */
export function withEffectiveVault(
  ctx: CallerContext,
  def: ToolDefinition,
  parsedInput: unknown,
): CallerContext {
  const v = (parsedInput as Record<string, unknown> | null)?.[def.vaultArg ?? "vault"];
  return typeof v === "string" && v !== ctx.vaultId
    ? { ...ctx, vaultId: v, callerVaultId: ctx.vaultId }
    : ctx;
}

/** Advertised JSON Schema for a tool input: drop `vault` from `required` and describe when it may
 *  be omitted, for exactly the schemas `withDefaultVault` can fill. Mutates and returns `json` (a
 *  fresh conversion, memoized per schema by the caller). */
export function relaxVaultInJson<T extends object>(json: T, schema: unknown): T {
  if (!isOmittableVaultArg(schema, "vault")) return json;
  const j = json as {
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
  };
  if (Array.isArray(j.required)) {
    j.required = j.required.filter((k) => k !== "vault");
    if (j.required.length === 0) delete j.required;
  }
  const prop = j.properties?.vault;
  if (prop) prop.description = VAULT_OMITTABLE_HINT;
  return json;
}
