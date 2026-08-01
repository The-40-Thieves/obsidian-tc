// WP5.1 (issue 15): run_serve's index-on-write wiring, extracted verbatim out of cli.ts. Split into
// TWO exported functions rather than one, because the source order they extract from is not
// contiguous: `wireIndexResources` (the embedding provider, the vec0/FTS probes, and the mutable
// indexHealth tracker) sits BEFORE cli.ts's job-queue/gateway construction and the inline
// health/index_status tool registrations (WP5.2 territory, and per the map's trap list those two
// `registry.register(` call sites must not move); `wireIndexCoordinator` (the coordinator, the
// reindex/deindex hooks, and the vault watcher) sits AFTER them, because its write handler needs
// `makeOnIndexed`, which depends on the job queue and gateway roles cli.ts still owns. Moving either
// function to close that gap would reorder real side-effecting boot steps, which the map's WP5
// acceptance criterion forbids ("startup order... unchanged"). See server-runtime.ts for why only
// `wireIndexResources` is folded into the argv-free composition entry.

import { type FolderAcl, makeIndexReadable, makeReindexGate } from "../acl";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { createEmbeddingProviderAsync, type EmbeddingsConfigLike } from "../embeddings";
import { recordIngestStats } from "../metrics/ingest-stats";
import type { MetricsRecorder } from "../metrics/registry";
import { ensureNotesFts } from "../search/fts";
import { IndexCoordinator } from "../search/index-coordinator";
import {
  deindexNote,
  type IndexHook,
  type IndexStats,
  type IndexVaultArgs,
  indexNote,
  indexVault,
} from "../search/indexer";
import {
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
} from "../search/representation";
import { ensureVecChunks, type VecRebuildEvent } from "../search/vec";
import { errorMessage } from "../util/errors";
import { registerVaultWatch } from "../vault/watcher";

// --- Group A: wireIndexResources -------------------------------------------------------------

export interface IndexResourcesDeps {
  db: Database;
  metrics: MetricsRecorder;
  /** config.embeddings */
  embeddings: EmbeddingsConfigLike & {
    batchSize: number;
    concurrency: number;
    maxBatchTokens: number;
    chunkContext: boolean;
  };
  /** THE-612: ensureVecChunks' onRebuild, routed to the metrics recorder by runtime/observability.ts. */
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** `dirname(configPath)` — the trust root for embeddings.modulePath. See
   *  `ResolveContext.configDir`'s doc comment (providers/types.ts) for the exact undefined-vs-set
   *  cases: it is NOT undefined in zero-config vault-path mode, only when `configPath` itself is
   *  absent. Review round 2 (Minor 5): corrected from a false "undefined when derived from a vault
   *  path" claim. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
}

/** THE-288: mutable index-health tracker surfaced by server_health. reconcile flips pending ->
 *  ok/degraded when the boot reconcile settles; writeFailures counts swallowed index-on-write
 *  errors (reindex/deindex best-effort). The health tool reads a snapshot at call time. */
export interface IndexHealthState {
  reconcile: "pending" | "ok" | "degraded";
  reconcileAt: number | null;
  reconcileErrors: Array<{ vault: string; error: string }>;
  writeFailures: number;
  lastWriteError?: string;
  /** THE-291: the notes/FTS metadata pass completed (independent of embed success). */
  notesReady: boolean;
  /** THE-457: fail-open audit writes that threw (locked DB / disk full) — the audit trail is lossy. */
  auditWriteFailures: number;
  /** THE-458 (audit #5): times the index-on-write queue depth crossed queueMax (backpressure edges). */
  indexQueueBackpressures: number;
  /** THE-491: chunks_upserted from the most recent index_vault tool call; null until the first one
   *  this process (get_index_status surfaces it verbatim). */
  lastChunksUpserted: number | null;
}

export interface IndexResources {
  embeddingProvider: EmbeddingProvider;
  /** GH #171/#172: the embed-batch knobs, threaded into every reconcile so local runners are tunable. */
  embedConfig: { batchSize: number; concurrency: number; maxBatchTokens: number };
  hasVec: boolean;
  hasFts: boolean;
  indexHealth: IndexHealthState;
  /** THE-507/THE-588: routes a real IndexStats pass to the Prometheus counters — importable and
   *  testable directly (see metrics/ingest-stats.ts's module doc comment for why). */
  recordIngestStatsFor: (vaultId: string, s: IndexStats) => IndexStats;
  /** THE-625 item 4: routes every direct indexVault(...) caller through the recorder instead of a
   *  per-call-site reminder (THE-590 found one caller left uninstrumented). */
  indexVaultRecorded: (opts: IndexVaultArgs) => Promise<IndexStats>;
}

/**
 * Build the embedding provider, probe vec0/FTS5 availability, and construct the mutable index-health
 * tracker. THE-460: the vec0 fingerprint covers provider/model/dims + the fixed representation
 * constants + whether chunkContext enrichment is on, so a same-dimension model swap or an
 * enrichment/chunker change rebuilds vec_chunks instead of serving it stale. THE-291: the FTS5 probe
 * is false on adapters without FTS5 or when OBSIDIAN_TC_DISABLE_FTS=1.
 */
export async function wireIndexResources(deps: IndexResourcesDeps): Promise<IndexResources> {
  const embeddingProvider = await createEmbeddingProviderAsync(deps.embeddings, {
    configDir: deps.configDir,
    securityProfile: deps.securityProfile,
  });
  const embedConfig = {
    batchSize: deps.embeddings.batchSize,
    concurrency: deps.embeddings.concurrency,
    maxBatchTokens: deps.embeddings.maxBatchTokens,
  };
  const hasVec = ensureVecChunks(
    deps.db,
    {
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: deps.embeddings.chunkContext ? ENRICHMENT_VERSION : 0,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
      // A checkpoint upgrade at the same model name and width is otherwise invisible. Undefined
      // reproduces the pre-existing fingerprint byte-for-byte.
      revision: deps.embeddings.revision,
    },
    {
      now: Date.now,
      onRebuild: deps.onVecRebuild,
      // Fix A: the backfill must match what chunk_embeddings.model actually stores.
      activeModel: embeddingProvider.id,
    },
  );
  const hasFts = ensureNotesFts(deps.db, { now: Date.now });
  const indexHealth: IndexHealthState = {
    reconcile: "pending",
    reconcileAt: null,
    reconcileErrors: [],
    writeFailures: 0,
    notesReady: false,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
  };
  const recordIngestStatsFor = (vaultId: string, s: IndexStats): IndexStats => {
    recordIngestStats(deps.db, deps.metrics, vaultId, s);
    return s;
  };
  const indexVaultRecorded = (opts: IndexVaultArgs): Promise<IndexStats> =>
    indexVault(opts).then((s) => recordIngestStatsFor(opts.vaultId, s));

  return {
    embeddingProvider,
    embedConfig,
    hasVec,
    hasFts,
    indexHealth,
    recordIngestStatsFor,
    indexVaultRecorded,
  };
}

// --- Group B: wireIndexCoordinator ------------------------------------------------------------

export interface IndexCoordinatorDeps {
  db: Database;
  embeddingProvider: EmbeddingProvider;
  hasVec: boolean;
  /** config.embeddings.chunkContext */
  chunkContext: boolean;
  /** config.indexing */
  indexing: { writeConcurrency: number; writeConcurrencyPerVault: number; queueMax: number };
  /** config.vaults, narrowed to what registerVaultWatch needs. */
  vaults: readonly { id: string; path: string }[];
  /** config.watch */
  watch: { enabled: boolean; debounceMs: number };
  sqlHooksFor: (vault: string) => WriteTxnHooks;
  /** THE-585 (#5)/THE-458 (audit #5): bump indexHealth's write-failure and backpressure counters —
   *  the SAME indexHealth `wireIndexResources` constructed, threaded in as a value (this function
   *  runs strictly after that one, so there is no forward-reference here). */
  indexHealth: Pick<
    IndexHealthState,
    "writeFailures" | "lastWriteError" | "indexQueueBackpressures"
  >;
  /** THE-295: root ACL + per-vault overrides, owned by governance. */
  acl: FolderAcl;
  aclByVault: Map<string, FolderAcl>;
  /** W-INGEST onIndexed hook -> contradiction-check enqueue. Owned by cli.ts (needs the job queue +
   *  gateway roles, WP5.2 territory) and passed in as a plain function — this module never
   *  constructs a job queue or a gateway client. */
  makeOnIndexed: (vaultId: string) => IndexHook | undefined;
}

export interface IndexCoordinatorWiring {
  indexCoordinator: IndexCoordinator;
  /** THE-453 (runtime): per-vault ACL read-visibility filter shared by the boot reconcile, runtime
   *  add_vault, AND the index-on-write hook below. */
  indexReadableFor: (vaultId: string) => (rel: string) => boolean;
  reindexHook: (vaultId: string, path: string, content: string) => void;
  deindexHook: (vaultId: string, path: string) => void;
  /** THE-649: stops the filesystem watch. Idempotent cleanup for this wiring step — the only
   *  resource it owns that outlives its own construction. */
  stopVaultWatch: () => void;
}

/**
 * THE-455: route every index-on-write mutation through a per-(vault,path) coordinator so same-path
 * writes/deletes serialize (newest wins) while different paths stay concurrent. THE-649: feed the
 * SAME reindexHook the write path uses into the vault watcher, so a watched change is read-ACL-gated
 * identically to a write_note.
 */
export function wireIndexCoordinator(deps: IndexCoordinatorDeps): IndexCoordinatorWiring {
  const indexCoordinator = new IndexCoordinator(
    {
      write: (vaultId, path, content) =>
        indexNote(
          deps.db,
          deps.embeddingProvider,
          vaultId,
          path,
          content,
          deps.hasVec,
          Date.now,
          deps.makeOnIndexed(vaultId),
          deps.chunkContext,
          deps.sqlHooksFor(vaultId),
        ),
      delete: (vaultId, path) =>
        deindexNote(
          deps.db,
          vaultId,
          path,
          deps.hasVec,
          deps.chunkContext,
          deps.sqlHooksFor(vaultId),
        ),
      onError: (e) => {
        deps.indexHealth.writeFailures++;
        deps.indexHealth.lastWriteError = errorMessage(e);
      },
    },
    {
      // THE-458 (audit #5): bound concurrent index/embed fan-out so a bulk mutation cannot spawn an
      // unbounded number of simultaneous embedding calls; surface sustained queue depth in health.
      globalConcurrency: deps.indexing.writeConcurrency,
      perVaultConcurrency: deps.indexing.writeConcurrencyPerVault,
      queueMax: deps.indexing.queueMax,
      onBackpressure: (depth) => {
        deps.indexHealth.indexQueueBackpressures++;
        process.stderr.write(
          `[index] write-queue backpressure: ${depth} distinct paths pending (> queueMax ` +
            `${deps.indexing.queueMax}); index/embed fan-out is capped, writes are queued not dropped\n`,
        );
      },
    },
  );
  const indexReadableFor = makeIndexReadable(deps.acl, deps.aclByVault);
  // THE-453 (runtime): a write-allowed but read-denied path (writePaths ⊃ readPaths) must not be
  // embedded — makeReindexGate routes it to submitDelete instead of submitWrite. Deletes are always
  // safe, so deindex stays a direct submitDelete.
  const reindexHook = makeReindexGate(indexReadableFor, {
    write: (vaultId, path, content) => indexCoordinator.submitWrite(vaultId, path, content),
    delete: (vaultId, path) => indexCoordinator.submitDelete(vaultId, path),
  });
  const deindexHook = (vaultId: string, path: string): void =>
    indexCoordinator.submitDelete(vaultId, path);
  const stopVaultWatch = registerVaultWatch(deps.vaults, deps.watch, {
    onUpsert: reindexHook,
    onDelete: deindexHook,
  });

  return { indexCoordinator, indexReadableFor, reindexHook, deindexHook, stopVaultWatch };
}
