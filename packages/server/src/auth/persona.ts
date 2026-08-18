// THE-647 item 2: resolve a JWT `persona` claim against the server's configured `personas` map.
//
// jwt.ts extracts the raw claim only — it has no access to server config. This is the ONE place
// resolution happens: a caller's effective grant is either exactly what its persona names, or the
// call is refused. It is never a union of "whatever the token said" and "whatever the persona
// says" — see PersonaConfigSchema's `scopes` doc comment for why that would be a privilege-widening
// bug, not a convenience.
import type { PersonasConfig, ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";

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
