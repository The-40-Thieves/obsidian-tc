import { FolderAcl } from "../acl";
import { withWikiLogScope } from "../tools/m7/knowledge/wiki-log-acl";

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
 *  the implicit rule that makes the generated `log.md` need `read:provenance` (wiki-log-acl.ts). */
export function buildAcls(
  aclConfig: FolderAclConfig,
  vaults: ReadonlyArray<{ id: string; acl?: unknown; wiki?: { folder?: string | undefined } }>,
): { acl: FolderAcl; aclByVault: Map<string, FolderAcl> } {
  return {
    acl: new FolderAcl(aclConfig),
    aclByVault: new Map(
      vaults
        .filter((v) => v.acl !== undefined || v.wiki?.folder !== undefined)
        .map((v) => [
          v.id,
          new FolderAcl(withWikiLogScope((v.acl as FolderAclConfig) ?? aclConfig, v.wiki?.folder)),
        ]),
    ),
  };
}
