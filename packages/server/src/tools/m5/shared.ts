// Shared wiring for the M5 memory/capture tools (THE-181). M5Deps is injected once
// in cli.ts onto the same ToolRegistry as M0-M4, so the M5 tools light up on both the
// stdio and HTTP edges. Capture/memory/workspace are in-process SQLite (+ vault file
// writes for materialization/JSONL/commit); only `plur` reaches an external service,
// and it is GLOBAL (one client, no per-vault wiring) because the engram store is
// global and the plur tools take no `vault` argument.
import { type BootstrapConfig, BootstrapConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import type { PlurClient } from "../../plur/client";
import type { VaultRegistry } from "../../vault/registry";
import type { ActiveSessionTracker } from "../../workspace/sessions";

/** Default vault folder for materialized memory-entity notes. */
export const DEFAULT_MEMORY_FOLDER = "memory";
/** Default vault folder for workspace-session JSONL traces. */
export const DEFAULT_TRACE_FOLDER = ".obsidian-tc/traces";

export interface M5Deps {
  vaultRegistry: VaultRegistry;
  /** THE-291: index-on-write hook for capture-commit writes (best-effort, backgrounded). */
  reindex?: (vaultId: string, path: string, content: string) => void;
  /** THE-209: active-session tracker; start_session/end_session maintain it, the transport reads it. */
  activeSessions?: ActiveSessionTracker;
  /** Global plur read client (HTTP endpoint or local CLI); undefined when unconfigured. */
  plur?: PlurClient;
  /** THE-101: session-bootstrap routing table (server-level). The private routing lives in config;
   *  absent -> DEFAULT_BOOTSTRAP (empty table + generic catch-up phrases), so session_bootstrap
   *  degrades to lightweight. */
  bootstrap?: BootstrapConfig;
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

/** Fully-defaulted bootstrap config (empty routing table + generic catch-up phrases), parsed once. */
const DEFAULT_BOOTSTRAP: BootstrapConfig = BootstrapConfigSchema.parse(undefined);

/** THE-101: the session-bootstrap routing table for this server, or the empty default. */
export function bootstrapConfigFor(deps: M5Deps): BootstrapConfig {
  return deps.bootstrap ?? DEFAULT_BOOTSTRAP;
}
