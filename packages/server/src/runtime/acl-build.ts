import { FolderAcl } from "../acl";

type FolderAclConfig = ConstructorParameters<typeof FolderAcl>[0];

/** THE-630 (review follow-up): the ONE construction of the root + per-vault ACL objects, shared by
 *  wireGovernance and wireDomainTools. Both call sites read the same `ServerConfig` within one
 *  `buildServerRuntime` call, and `FolderAcl` is a pure function of its config, so the two
 *  invocations are behaviorally identical — but before this helper existed the construction was
 *  DUPLICATED in both files with only a comment as the sync contract, and a future ACL change
 *  landing in one and not the other would have let federated legs authorize under stale rules.
 *  Change ACL construction HERE and nowhere else. */
export function buildAcls(
  aclConfig: FolderAclConfig,
  vaults: ReadonlyArray<{ id: string; acl?: unknown }>,
): { acl: FolderAcl; aclByVault: Map<string, FolderAcl> } {
  return {
    acl: new FolderAcl(aclConfig),
    aclByVault: new Map(
      vaults
        .filter((v) => v.acl !== undefined)
        .map((v) => [v.id, new FolderAcl(v.acl as FolderAclConfig)]),
    ),
  };
}
