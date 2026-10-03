import { FolderAcl } from "../acl";
import { foldersShareDirectory, rawFolderPlacement } from "../tools/m7/knowledge/wiki-folder";
import { wikiLogRules, withWikiLogScope } from "../tools/m7/knowledge/wiki-log-acl";
import { resolveVaultPathChecked } from "../vault/paths";
import { immutableGlobsFor, rawFolderOf } from "../vault/raw-folder";
import { canonicalizeVaultRoot, canonicalizeVaultRootWithStatus } from "../vault/registry";

type FolderAclConfig = ConstructorParameters<typeof FolderAcl>[0];

/** THE-630 (review follow-up): the ONE construction of the root + per-vault ACL objects, shared by
 *  wireGovernance and wireDomainTools. Both call sites read the same `ServerConfig` within one
 *  `buildServerRuntime` call, and `FolderAcl` is a pure function of its config, so the two
 *  invocations are behaviorally identical — but before this helper existed the construction was
 *  DUPLICATED in both files with only a comment as the sync contract, and a future ACL change
 *  landing in one and not the other would have let federated legs authorize under stale rules.
 *  Change ACL construction HERE and nowhere else.
 *
 *  A vault with a wiki folder gets its own ACL even when its config declares none: the root ACL plus
 *  the implicit rule that makes the generated `log.md` need `read:provenance` (wiki-log-acl.ts, on
 *  the wiki folder's real directory too when it is a symlink), and
 *  the raw-sources folder (`wiki.rawFolder`), which is immutable whatever the ACL says. The two are
 *  independent additions on different fields (a `rules` entry that only adds a scope, and
 *  `immutablePaths` entries that only add write denials), so neither can loosen the other nor an
 *  operator's own rules; an operator's `immutablePaths` are kept. */
export function buildAcls(
  aclConfig: FolderAclConfig,
  vaults: ReadonlyArray<{
    id: string;
    /** The vault's root: with it the raw folder's real directory is locked as well as its name. */
    path?: string;
    acl?: unknown;
    wiki?: { folder: string; rawFolder?: string | undefined } | undefined;
  }>,
): { acl: FolderAcl; aclByVault: Map<string, FolderAcl> } {
  const aclByVault = new Map<string, FolderAcl>();
  for (const v of vaults) {
    const raw = rawFolderOf(v.id, v.wiki);
    if (v.acl === undefined && v.wiki?.folder === undefined && raw === undefined) continue;
    const operator = (v.acl as FolderAclConfig | undefined) ?? aclConfig;
    const placed = canonicalWikiFolder(v);
    const base = withWikiLogScope(operator, v.wiki?.folder, placed.folder);
    const locked = raw === undefined ? [] : [raw, ...canonicalRawTarget(v, raw)];
    // A wiki folder that could not be placed (the root is unavailable now) is placed on a later
    // request, once the root exists: the rule on the real log.md is added then, so a symlink that
    // appears with the root cannot leave the log readable without the scope.
    const late =
      placed.known || v.wiki?.folder === undefined
        ? undefined
        : () => {
            const later = canonicalWikiFolder(v, false);
            if (!later.known) return undefined;
            return later.folder === undefined ? [] : wikiLogRules(operator, [later.folder]);
          };
    aclByVault.set(
      v.id,
      new FolderAcl(
        locked.length === 0
          ? base
          : {
              ...base,
              immutablePaths: [...(base.immutablePaths ?? []), ...immutableGlobsFor(...locked)],
            },
        late,
      ),
    );
  }
  return { acl: new FolderAcl(aclConfig), aclByVault };
}

/** The in-vault directory a symlinked wiki folder really is (`""`: the vault root), so that the
 *  `log.md` read scope holds when the log is reached by that name. `folder` is undefined when the
 *  folder is the directory it says; `known: false` when the vault root is unavailable now, so
 *  nothing can be resolved yet (the caller asks again once the root exists). A folder that cannot be
 *  placed inside the vault throws at build time: the scope cannot be installed on a path nobody can
 *  name, and starting without it would leave the log readable, so this fails closed. Later, when it
 *  is asked again, that same state reads as not known (no request can reach a real path outside the
 *  vault) rather than failing every read. */
function canonicalWikiFolder(
  v: { id: string; path?: string; wiki?: { folder: string } | undefined },
  building = true,
): { known: true; folder: string | undefined } | { known: false; folder?: undefined } {
  if (v.path === undefined || v.wiki === undefined) return { known: true, folder: undefined };
  const { root, canonical } = canonicalizeVaultRootWithStatus(v.path);
  if (!canonical) return { known: false };
  let real: string;
  try {
    real = resolveVaultPathChecked(root, v.wiki.folder).aclRel;
  } catch {
    if (!building) return { known: false };
    throw new Error(
      `vault "${v.id}": wiki.folder (${JSON.stringify(v.wiki.folder)}) cannot be placed inside the vault once symlinks are resolved, so the read:provenance scope on its log.md cannot be installed`,
    );
  }
  return { known: true, folder: real === v.wiki.folder ? undefined : real };
}

/** The in-vault directory a symlinked raw folder really is, so that writing it by that name is as
 *  immutable as writing it by the configured one: `[]` when the folder is a plain directory, does not
 *  exist yet (the ACL is built at startup: a symlink made later is picked up on the next restart) or
 *  its identity cannot be established, in which case nothing extra is locked and ingest refuses it
 *  (readRawSource). Throws when the raw folder and the wiki folder are one directory by identity. */
function canonicalRawTarget(
  v: { id: string; path?: string; wiki?: { folder: string } | undefined },
  raw: string,
): string[] {
  if (v.path === undefined) return [];
  const root = canonicalizeVaultRoot(v.path);
  const placed = rawFolderPlacement(root, raw);
  if (!placed.ok) return [];
  if (v.wiki && foldersShareDirectory(root, v.wiki.folder, raw))
    throw new Error(
      `vault "${v.id}": wiki.rawFolder (${JSON.stringify(raw)}) is the same directory as, holds, or sits inside wiki.folder (${JSON.stringify(v.wiki.folder)}) once symlinks are resolved`,
    );
  return placed.canonical === null ? [] : [placed.canonical];
}
