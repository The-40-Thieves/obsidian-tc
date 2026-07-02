// Shared wiring for the M5 memory/capture tools (THE-181). M5Deps is injected once
// in cli.ts onto the same ToolRegistry as M0-M4, so the M5 tools light up on both the
// stdio and HTTP edges. Capture/memory/workspace are in-process SQLite (+ vault file
// writes for materialization/JSONL/commit); only `plur` reaches an external service,
// and it is GLOBAL (one client, no per-vault wiring) because the engram store is
// global and the plur tools take no `vault` argument.
import type { BridgeClient } from "../../bridge";
import type { VaultRegistry } from "../../vault/registry";
import type { ActiveSessionTracker } from "../../workspace/sessions";

/** Default vault folder for materialized memory-entity notes. */
export const DEFAULT_MEMORY_FOLDER = "memory";
/** Default vault folder for workspace-session JSONL traces. */
export const DEFAULT_TRACE_FOLDER = ".obsidian-tc/traces";

export interface M5Deps {
  vaultRegistry: VaultRegistry;
  /** THE-209: active-session tracker; start_session/end_session maintain it, the transport reads it. */
  activeSessions?: ActiveSessionTracker;
  /** Global plur read client; undefined when no plur endpoint is configured. */
  plur?: BridgeClient;
  /** Per-vault memory materialization folder; defaults to "memory". */
  memoryFolder?: (vaultId: string) => string;
  /** Per-vault workspace trace folder; defaults to ".obsidian-tc/traces". */
  traceFolder?: (vaultId: string) => string;
}

export function memoryFolderFor(deps: M5Deps, vaultId: string): string {
  return deps.memoryFolder?.(vaultId) ?? DEFAULT_MEMORY_FOLDER;
}

export function traceFolderFor(deps: M5Deps, vaultId: string): string {
  return deps.traceFolder?.(vaultId) ?? DEFAULT_TRACE_FOLDER;
}
