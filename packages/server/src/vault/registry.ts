// Multi-vault registry/resolver. Maps a tool's `vault` argument to a configured
// vault root. Built once from config.vaults and closed over by tool factories.
import { resolve } from "node:path";
import { err, type VaultConfig } from "@the-40-thieves/obsidian-tc-shared";

export interface ResolvedVault {
  id: string;
  name: string;
  root: string; // absolute filesystem path
  restApiUrl?: string;
  restApiKey?: string;
}

export class VaultRegistry {
  private readonly byId = new Map<string, ResolvedVault>();
  private readonly defaultId: string;

  constructor(vaults: VaultConfig[], defaultId?: string) {
    if (vaults.length === 0) throw new Error("VaultRegistry requires at least one vault");
    for (const v of vaults) {
      this.byId.set(v.id, {
        id: v.id,
        name: v.name ?? v.id,
        root: resolve(v.path),
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
