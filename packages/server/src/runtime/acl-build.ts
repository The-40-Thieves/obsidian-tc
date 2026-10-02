import { FolderAcl } from "../acl";
import { withWikiLogScope } from "../tools/m7/knowledge/wiki-log-acl";
import { immutableGlobsFor, rawFolderOf } from "../vault/raw-folder";

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
 *  the implicit rule that makes the generated `log.md` need `read:provenance` (wiki-log-acl.ts), and
 *  the raw-sources folder (`wiki.rawFolder`), which is immutable whatever the ACL says. The two are
 *  independent additions on different fields (a `rules` entry that only adds a scope, and
 *  `immutablePaths` entries that only add write denials), so neither can loosen the other nor an
 *  operator's own rules; an operator's `immutablePaths` are kept. */
export function buildAcls(
  aclConfig: FolderAclConfig,
  vaults: ReadonlyArray<{
    id: string;
    acl?: unknown;
    wiki?: { folder: string; rawFolder?: string | undefined } | undefined;
  }>,
): { acl: FolderAcl; aclByVault: Map<string, FolderAcl> } {
  const aclByVault = new Map<string, FolderAcl>();
  for (const v of vaults) {
    const raw = rawFolderOf(v.id, v.wiki);
    if (v.acl === undefined && v.wiki?.folder === undefined && raw === undefined) continue;
    const base = withWikiLogScope((v.acl as FolderAclConfig | undefined) ?? aclConfig, v.wiki?.folder);
    aclByVault.set(
      v.id,
      new FolderAcl(
        raw === undefined
          ? base
          : { ...base, immutablePaths: [...(base.immutablePaths ?? []), ...immutableGlobsFor(raw)] },
      ),
    );
  }
  return { acl: new FolderAcl(aclConfig), aclByVault };
}
