// The doctor views that need the folder ACLs built: memory.read-acl (each vault's effective ACL),
// config.path-globs (the per-vault case behavior the glob verdicts match with) and
// vaults.case-sensitivity (the resolution itself). ONE buildAcls serves all three, so the views
// and the runtime can never disagree about what a vault's ACL was compiled with — and doctor.ts
// stays under biome's 700-line ceiling.

import { DEFAULT_MEMORY_FOLDER, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { DeadPathGlobsView } from "../../doctor/dead-path-globs";
import { deadPathGlobsView } from "../../doctor/dead-path-globs";
import type { MemoryReadAclView } from "../../doctor/memory-read-acl";
import {
  type VaultCaseSensitivityView,
  vaultCaseSensitivityView,
} from "../../doctor/vault-case-sensitivity";
import { buildAcls } from "../../runtime/acl-build";

/** The three ACL-derived doctor views. `memoryEntities` is the optional probe rows for
 *  memory.read-acl (absent = "not probed", never a false ok). */
export function aclDoctorViews(
  config: ServerConfig,
  memoryEntities: ReturnType<NonNullable<MemoryReadAclView["probe"]>> | undefined,
): {
  memoryReadAcl: MemoryReadAclView;
  pathGlobs: DeadPathGlobsView;
  vaultCaseSensitivity: VaultCaseSensitivityView;
} {
  const built = buildAcls(config.acl, config.vaults);
  return {
    memoryReadAcl: {
      vaults: config.vaults.map((v) => ({
        id: v.id,
        memoryFolder: v.memory?.folder ?? DEFAULT_MEMORY_FOLDER,
        acl: built.aclByVault.get(v.id) ?? built.acl,
      })),
      ...(memoryEntities !== undefined ? { probe: () => memoryEntities } : {}),
    },
    pathGlobs: deadPathGlobsView(
      config,
      new Map([...built.caseByVault].map(([id, info]) => [id, info.caseInsensitive])),
    ),
    vaultCaseSensitivity: vaultCaseSensitivityView(
      built.caseByVault,
      config.vaults.map((v) => v.id),
    ),
  };
}
