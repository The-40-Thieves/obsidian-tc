// Multi-vault registry/resolver. Maps a tool's `vault` argument to a configured
// vault root. Built once from config.vaults and closed over by tool factories.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { err, type VaultConfigInput, type VaultKind } from "@the-40-thieves/obsidian-tc-shared";

/**
 * Canonicalize a configured vault root through realpath, once, at registration (THE-1081 / #946).
 * `packages/native/src/lib.rs`'s `open_parent` walks every path component with O_NOFOLLOW from
 * `/`, so a root reached through a symlinked ANCESTOR (macOS `$TMPDIR` resolves under `/var` ->
 * `/private/var`) makes the native addon refuse every read/write in that vault even though the
 * root itself is legitimate. Resolving here means both the native addon and the JS fallback open
 * the vault by the same real path — this does not relax anything INSIDE the vault: a symlink
 * there is still refused by open_parent (native) and by resolveVaultPathChecked's own realpath
 * containment check (paths.ts, JS side).
 *
 * `.native` (not plain `realpathSync`) matches this repo's existing realpath idiom
 * (vault/watcher.ts, THE-657) and is applied unconditionally on every platform rather than
 * branched on win32: a platform-conditional fix would leave the one platform that needs it
 * uncovered by the other CI legs, and `.native` is also what expands a Windows 8.3 short name,
 * which the plain JS realpath does not.
 *
 * Falls back to the lexically-resolved path when realpath fails (the root doesn't exist yet, or
 * is transiently unavailable) — resolveVaultPathChecked already fails closed with
 * `vault_not_found` for that case at request time, and this must not turn a missing/racy vault
 * root into a startup crash. Reviewer round (Medium 2): that fallback means a vault registered
 * before its directory existed is only ever known by its LEXICAL path, and a local user who later
 * plants a symlink at that exact path would have it silently dereferenced by the JS backend's own
 * realpath containment check. `resolveVaultPathChecked` (paths.ts) closes that by refusing a root
 * whose final component is a symlink at resolution time — see its own comment for why that check
 * needs no `rootCanonical` state threaded into it to only fire on the un-canonicalized case.
 * `ResolvedVault.rootCanonical` (below) still records which case a vault is in, for callers (e.g.
 * `doctor`) that want to warn about it before it ever gets used.
 */
function canonicalizeVaultRootWithStatus(path: string): { root: string; canonical: boolean } {
  const lexical = resolve(path);
  try {
    return { root: realpathSync.native(lexical), canonical: true };
  } catch {
    return { root: lexical, canonical: false };
  }
}

export function canonicalizeVaultRoot(path: string): string {
  return canonicalizeVaultRootWithStatus(path).root;
}

export interface ResolvedVault {
  id: string;
  name: string;
  root: string; // absolute filesystem path
  /** THE-1081 review round (Medium 2): true when `root` was realpath-canonicalized at
   *  registration; false when the configured path could not be resolved then (missing /
   *  transiently unavailable) and `root` is only its lexical form. */
  rootCanonical: boolean;
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
      const { root, canonical } = canonicalizeVaultRootWithStatus(v.path);
      this.byId.set(v.id, {
        id: v.id,
        name: v.name ?? v.id,
        root,
        rootCanonical: canonical,
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
    const { root, canonical } = canonicalizeVaultRootWithStatus(v.path);
    const resolved: ResolvedVault = {
      id: v.id,
      name: v.name ?? v.id,
      root,
      rootCanonical: canonical,
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
