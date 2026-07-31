// Shared wiring for the M2 search/index tools (WP7: M2Deps lives in its own leaf module so
// implementation files can import it without pulling in index.ts's barrel — which imports every
// implementation file back, and previously made each of those a two-node import cycle through
// ./index).
import type { BridgeClient } from "../../bridge";
import type { EmbeddingProvider } from "../../embeddings";
import type { RetrievalLogger } from "../../experiential/log";
import type { IndexStats } from "../../search/indexer";
import type { VaultRegistry } from "../../vault/registry";

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
  densify?: {
    tagEdges?: boolean;
    knnEdges?: boolean;
    knnK?: number;
    knnMinSim?: number;
    maxTagFanout?: number;
  };
  /** THE-230: serve-path retrieval logging into the experiential store; absent -> no logging
   *  (tests, or experiential.logRetrievals=false). */
  retrievalLog?: RetrievalLogger;
  /** THE-491: fired with the completed stats after each index_vault call, so get_index_status
   *  can report chunks_upserted from the most recent run; absent -> not tracked. THE-590 widened
   *  this from `{ chunks_upserted: number }` to the full IndexStats so a production caller can
   *  also thread the pass through recordIngestStats (metrics/ingest-stats.ts) — the MCP
   *  index_vault path was the one caller that never fed the Prometheus counters / event_log. */
  onIndexVaultComplete?: (vaultId: string, stats: IndexStats) => void;
  /** THE-490/THE-591: config.indexing.streamingWalk. Off/absent -> index_vault's walk is
   *  byte-identical to before this flag existed (indexVault's default eager walkVault). */
  streamingWalk?: boolean;
}
