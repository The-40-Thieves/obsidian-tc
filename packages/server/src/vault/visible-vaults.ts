import type { FolderAcl } from "../acl";
import type { VaultRegistry } from "./registry";

/** The slice of a caller context that decides which vaults it can see. */
export interface VaultVisibilityCaller {
  vaultId: string;
  vaultBound?: boolean;
}

/**
 * The vault ids a caller may act on: the ONE definition behind `list_vaults`-style hints (a bad
 * `vault` error's `visible_vaults`) and the omitted-`vault` default (registry/vault-default.ts).
 *
 * Two gates, both mandatory so neither surface can name a vault the caller cannot use:
 *  - token vault binding (THE-924): a bound (HTTP-token) caller sees only its own vault; the
 *    trusted, unbound caller (stdio, an unbound token) sees every configured vault;
 *  - the vault's own folder ACL: a vault whose effective `readPaths` whitelist is EMPTY lets the
 *    caller read nothing at all, so it is hidden rather than offered as a target.
 */
export function makeVisibleVaultIds(
  vaultRegistry: Pick<VaultRegistry, "list" | "resolve">,
  aclFor: (vaultId: string) => FolderAcl | undefined,
): (ctx: VaultVisibilityCaller) => string[] {
  const readable = (id: string): boolean => aclFor(id)?.readPaths?.length !== 0;
  return (ctx) => {
    if (ctx.vaultBound !== true)
      return vaultRegistry
        .list()
        .map((v) => v.id)
        .filter(readable);
    try {
      const id = vaultRegistry.resolve(ctx.vaultId).id;
      return readable(id) ? [id] : [];
    } catch {
      return [];
    }
  };
}
