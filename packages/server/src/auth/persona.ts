// THE-647 item 2: resolve a JWT `persona` claim against the server's configured `personas` map.
//
// jwt.ts extracts the raw claim only — it has no access to server config. This is the ONE place
// resolution happens: a caller's effective grant is either exactly what its persona names, or the
// call is refused. It is never a union of "whatever the token said" and "whatever the persona
// says" — see PersonaConfigSchema's `scopes` doc comment for why that would be a privilege-widening
// bug, not a convenience.
import {
  grantsScope,
  type PersonasConfig,
  type ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";

export interface PersonaResolution {
  vaultId: string;
  scopes: Set<string>;
  toolVisibility?: ToolVisibilityConfig;
  persona: string;
}

export type PersonaResolutionResult =
  | { ok: true; resolution: PersonaResolution }
  | { ok: false; reason: "unknown_persona" | "vault_not_in_persona" };

/**
 * FAILS CLOSED on both failure modes: a `persona` name absent from `personas` (misconfigured
 * token, or `personas` not configured at all), and a token's own `vault` claim naming a vault
 * outside that persona's `vaults`. Neither degrades to the token's raw scopes/vault — an unknown
 * persona is refused entirely rather than silently falling through to a WIDER grant than the
 * operator configured.
 */
export function resolvePersona(
  personaName: string,
  requestedVault: string | undefined,
  personas: PersonasConfig | undefined,
): PersonaResolutionResult {
  const cfg = personas?.[personaName];
  if (!cfg) return { ok: false, reason: "unknown_persona" };
  const vaultId = requestedVault ?? cfg.vaults[0];
  if (vaultId === undefined || !cfg.vaults.includes(vaultId)) {
    return { ok: false, reason: "vault_not_in_persona" };
  }
  return {
    ok: true,
    resolution: {
      vaultId,
      scopes: new Set(cfg.scopes),
      toolVisibility: cfg.toolVisibility,
      persona: personaName,
    },
  };
}

/**
 * Authorization-server tokens only (design v2 section 4.2, owner decision 4): the effective scopes
 * of a persona are `persona.scopes` INTERSECT the token's own `scope`. It only ever REMOVES: a scope
 * the token holds but the persona lacks is not granted, and a token wider than its persona leaves
 * the persona's scopes as they are. That is what keeps an OAuth client's down-scoping meaningful.
 * A hand-minted persona token does not come through here; its persona's scopes replace its own.
 *
 * Honours family and global wildcards on either side (`grantsScope`), keeping the NARROWER scope
 * when they differ (persona `read:*` with token `read:notes` -> `read:notes`).
 */
export function narrowToTokenScopes(
  personaScopes: ReadonlySet<string>,
  tokenScopes: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const p of personaScopes) if (grantsScope(tokenScopes, p)) out.add(p);
  for (const t of tokenScopes) if (grantsScope(personaScopes, t)) out.add(t);
  return out;
}
