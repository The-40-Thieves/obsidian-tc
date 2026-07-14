// M2 tool registration. Registered onto the same shared ToolRegistry assembled in
// cli.ts, so M2 lights up on both the stdio and HTTP edges alongside M0/M1.
import type { BridgeClient } from "../../bridge";
import type { EmbeddingProvider } from "../../embeddings";
import type { RetrievalLogger } from "../../experiential/log";
import type { ToolRegistry } from "../../mcp/registry";
import type { VaultRegistry } from "../../vault/registry";
import { buildIndexTools } from "./index-tools";
import { buildSearchTools } from "./search-tools";

export interface M2Deps {
  vaultRegistry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
  /**
   * Optional Dataview-bridge accessor (wired by cli.ts from the M4 substrate).
   * Returns a connected client + the per-vault timeout, or throws a degraded
   * error (plugin_missing / plugin_unreachable). When absent, search_dql and
   * search_vault(mode:dql) report plugin_missing — the honest "bridge not
   * configured" state, so M2-only harnesses need no bridge.
   */
  dataviewBridge?: (vaultId: string) => { client: BridgeClient; timeoutMs: number };
  /** THE-293: worker-time budget (ms) for one search_regex / search_vault(mode:regex) call.
   *  Absent -> the 2000ms default inside searchRegex. */
  regexTimeoutMs?: number;
  /** THE-291 (3B): lexical/metadata index readiness. hasFts = FTS5 probe result; ready() flips
   *  when the boot reconcile's notes pass committed (independent of embedding success). Absent
   *  (tests) -> disk scans, the portable floor. */
  metadataIndex?: { hasFts: boolean; ready: () => boolean };
  /** THE-406: embeddings.chunkContext — index_vault embeds/BM25-indexes chunks with the note-title
   *  + heading-breadcrumb prefix. Must match the boot reconcile's value (cli.ts threads both from
   *  the same config field); a mismatch would re-embed the vault on every alternating pass. */
  chunkContext?: boolean;
  /** Graph densification: index_vault builds derived edges (tag + kNN) when set. Threaded from
   *  config.retrieval.densify, mirroring chunkContext. */
  densify?: { tagEdges?: boolean; knnEdges?: boolean; knnK?: number; maxTagFanout?: number };
  /** THE-230: serve-path retrieval logging into the experiential store; absent -> no logging
   *  (tests, or experiential.logRetrievals=false). */
  retrievalLog?: RetrievalLogger;
}

export function registerM2Tools(registry: ToolRegistry, deps: M2Deps): void {
  for (const tool of buildIndexTools(deps)) registry.register(tool);
  for (const tool of buildSearchTools(deps)) registry.register(tool);
}
