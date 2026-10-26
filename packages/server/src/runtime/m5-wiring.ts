// M5 (capture, memory, workspace, session, plur) registration, split out of tool-wiring.ts to keep
// that file under the 700-line cap. The index hooks are the coordinator-backed reindex/deindex the
// other domains share; test/m5-wiring-deindex.test.ts drives this directly.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { ToolRegistry } from "../mcp/registry";
import type { MetricsRecorder } from "../metrics/registry";
import { createPlurBackend } from "../plur/client";
import type { ProvenanceStamper } from "../provenance/stamp";
import { registerM5Tools } from "../tools/m5";
import type { VaultRegistry } from "../vault/registry";
import type { ActiveSessionTracker } from "../workspace/sessions";
import type { memoryVaultAccessors } from "./memory-vault-accessors";

export interface M5WiringDeps {
  registry: ToolRegistry;
  config: ServerConfig;
  vaultRegistry: VaultRegistry;
  activeSessions?: ActiveSessionTracker;
  reindex: (vaultId: string, path: string, content: string) => void;
  deindex: (vaultId: string, path: string) => void;
  metrics?: MetricsRecorder;
  provenanceStamp?: ProvenanceStamper | undefined;
}

export function wireM5Tools(
  deps: M5WiringDeps,
  memory: Pick<
    ReturnType<typeof memoryVaultAccessors>,
    "memoryFolder" | "supersededInNote" | "traceFolder" | "memoryDefense"
  >,
): void {
  const { config } = deps;
  // GH #1027: tools.defaults.responseFormat, the same value wireDomainTools threads to its domains.
  const responseFormat = config.tools?.defaults?.responseFormat;
  registerM5Tools(deps.registry, {
    vaultRegistry: deps.vaultRegistry,
    responseFormat,
    // THE-737: traces live beside cache.db / experiential.db now, not in the vault.
    cacheDir: config.cacheDir,
    activeSessions: deps.activeSessions,
    reindex: deps.reindex,
    deindex: deps.deindex,
    plur: createPlurBackend(config.plur),
    bootstrap: config.bootstrap,
    memoryFolder: memory.memoryFolder,
    supersededInNote: memory.supersededInNote,
    traceFolder: memory.traceFolder,
    memoryDefense: memory.memoryDefense,
    metrics: deps.metrics,
    // delete_entity keeps a pre-image of the note it removes, as M1's destructive writers do.
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    ...(deps.provenanceStamp ? { provenanceStamp: deps.provenanceStamp } : {}),
  });
}
