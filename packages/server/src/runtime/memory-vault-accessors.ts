// Per-vault memory config accessors for the M5/M7/M8 tool deps. Each is a closure over the vault's
// own map, defaulted at the read site (the same shape every memory seam uses). Lifted out of
// tool-wiring.ts, which sits at biome's 700-line ceiling.
import {
  DEFAULT_MEMORY_FOLDER,
  type VaultMemoryDefenseConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { MEMORY_DEFENSE_OFF } from "../experiential/memory-defense";
import { DEFAULT_TRACE_FOLDER } from "../tools/m5";

export interface MemoryVaultMaps {
  memoryFolderByVault: Map<string, string>;
  /** memory.supersededInNote, present only for a vault that configured a `memory` block. */
  supersededInNoteByVault: Map<string, boolean>;
  traceFolderByVault: Map<string, string>;
  memoryDefenseByVault: Map<string, VaultMemoryDefenseConfig>;
}

export function memoryVaultAccessors(maps: MemoryVaultMaps): {
  memoryFolder: (vaultId: string) => string;
  supersededInNote: (vaultId: string) => boolean;
  traceFolder: (vaultId: string) => string;
  memoryDefense: (vaultId: string) => VaultMemoryDefenseConfig;
} {
  return {
    memoryFolder: (vaultId) => maps.memoryFolderByVault.get(vaultId) ?? DEFAULT_MEMORY_FOLDER,
    // Absent -> true, the schema default.
    supersededInNote: (vaultId) => maps.supersededInNoteByVault.get(vaultId) ?? true,
    traceFolder: (vaultId) => maps.traceFolderByVault.get(vaultId) ?? DEFAULT_TRACE_FOLDER,
    // GH #994: absent -> MEMORY_DEFENSE_OFF (mode "off", no scan).
    memoryDefense: (vaultId) => maps.memoryDefenseByVault.get(vaultId) ?? MEMORY_DEFENSE_OFF,
  };
}
