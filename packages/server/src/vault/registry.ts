// Multi-vault registry/resolver. Maps a tool's `vault` argument to a configured
// vault root. Built once from config.vaults and closed over by tool factories.
import { resolve } from "node:path";
import { err, type VaultConfigInput, type VaultKind } from "@the-40-thieves/obsidian-tc-shared";

export interface ResolvedVault {
  id: string;
  name: string;
  root: string; // absolute filesystem path
  /** P1.5: code-enforced isolation kind. The read:docs tools accept only `docs`. */
  kind: VaultKind;
  restApiUrl?: string;
  restApiKey?: string;
}

export class VaultRegistry {
  private readonly byId = new Map<string, ResolvedVault>();
  private readonly defaultId: string;

  constructor(vaults: VaultConfigInput[], defaultId?: string) {
    if (vaults.length === 0) throw new Error("VaultRegistry requires at least one vault");
    for (const v of vaults) {
      this.byId.set(v.id, {
        id: v.id,
        name: v.name ?? v.id,
        root: resolve(v.path),
        kind: v.kind ?? "private",
        restApiUrl: v.restApiUrl,
        restApiKey: v.restApiKey,
      });
    }
    const first = vaults[0];
    if (!first) throw new Error("VaultRegistry requires at least one vault");
    this.defaultId = defaultId && this.byId.has(defaultId) ? defaultId : first.id;
  }

  /** Resolve a vault id (or the default when omitted) -> vault_not_found if unknown. */
  resolve(vault?: string | null): ResolvedVault {
    const id = vault ?? this.defaultId;
    const v = this.byId.get(id);
    if (!v) throw err.vaultNotFound(`vault not found: ${id}`, { vault: id });
    return v;
  }

  /** THE-376: register a new vault at runtime (add_vault). Throws invalid_input if the id is
   *  already taken. The path is resolved to an absolute root. */
  register(v: {
    id: string;
    path: string;
    name?: string;
    kind?: VaultKind;
    restApiUrl?: string;
    restApiKey?: string;
  }): ResolvedVault {
    if (this.byId.has(v.id))
      throw err.invalidInput(`vault already registered: ${v.id}`, { vault: v.id });
    const resolved: ResolvedVault = {
      id: v.id,
      name: v.name ?? v.id,
      root: resolve(v.path),
      // P1.5: a runtime-added vault (add_vault) is `private` unless explicitly stated.
      kind: v.kind ?? "private",
      restApiUrl: v.restApiUrl,
      restApiKey: v.restApiKey,
    };
    this.byId.set(v.id, resolved);
    return resolved;
  }

  list(): ResolvedVault[] {
    return [...this.byId.values()];
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  get default(): string {
    return this.defaultId;
  }
}
