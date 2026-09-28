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
import {
  applyStickyEmbeddings,
  type StickyEmbeddingsResolution,
} from "../embeddings/sticky-provider";
import { recordIngestStats } from "../metrics/ingest-stats";
import type { MetricsRecorder } from "../metrics/registry";
import type { EgressFilter } from "../plane/egress-filter";
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
import { buildRepresentationManifest, type RepresentationManifest } from "../search/representation";
import { ensureVecChunks, type VecRebuildEvent } from "../search/vec";
import { errorMessage } from "../util/errors";
import { registerVaultWatch } from "../vault/watcher";

// --- Group A: wireIndexResources -------------------------------------------------------------

export interface IndexResourcesDeps {
  db: Database;
  metrics: MetricsRecorder;
  /** config.embeddings. `onProviderChange` is required (not part of the narrower
   *  `EmbeddingsConfigLike`) because GH #995 fix round 2 (item B) applies sticky resolution HERE —
   *  see this function's own doc comment — and `resolveStickyEmbeddings` needs it. Every real
   *  caller passes the actual `config.embeddings`, which always carries it (schema default
   *  "keep"). */
  embeddings: EmbeddingsConfigLike & {
    batchSize: number;
    concurrency: number;
    maxBatchTokens: number;
    chunkContext: boolean;
    onProviderChange: "keep" | "switch";
  };
  /** config.vaults, narrowed to the id every sticky-resolution query needs. GH #995 fix round 2
   *  (item B): required so `wireIndexResources` can apply sticky resolution itself rather than
   *  relying on every caller to have done so first — see this function's own doc comment. */
  vaults: ReadonlyArray<{ id: string }>;
  /** THE-612: ensureVecChunks' onRebuild, routed to the metrics recorder by runtime/observability.ts. */
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** `dirname(configPath)` — the trust root for embeddings.modulePath. See
   *  `ResolveContext.configDir`'s doc comment (providers/types.ts) for the exact undefined-vs-set
   *  cases: it is NOT undefined in zero-config vault-path mode, only when `configPath` itself is
   *  absent. Review round 2 (Minor 5): corrected from a false "undefined when derived from a vault
   *  path" claim. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
  /** THE-1122: config.cacheDir. Threaded into createEmbeddingProviderAsync so the "local"
   *  embeddings entry fetches its pinned model weights under `<cacheDir>/models/embedder-local/`
   *  rather than falling back to a CWD-relative default — see ResolveContext.cacheDir's own
   *  comment (providers/types.ts). Optional so a caller that predates this keeps working
   *  (falls back to the relative default, same as before this field existed). */
  cacheDir?: string;
  /** THE-424: config.indexing.chunkTokens. Lives on `indexing` rather than `embeddings`, so it is
   *  threaded in beside the embeddings block rather than through it — but it must reach the
   *  manifest, because this is the ONE place a representation identity is derived and chunk size
   *  is part of that identity. Optional so a caller that predates it keeps the 512 default. */
  chunkTokens?: number;
  /** THE-934 fix round 1: config.egress.excludePaths, compiled. Threaded into
   *  createEmbeddingProviderAsync -- the embedding PORT -- so the provider this returns is
   *  guarded before ANY consumer sees it (indexVault, indexNote/the write path, the query
   *  encoder, the advisory sweep, everything). Absent -> excludes nothing. */
  excludeFilter?: EgressFilter;
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
  /** THE-645: set while an index_vault call is in flight, updated once per completed flush()
   *  batch; cleared back to null in the tool's onIndexVaultComplete (success) and
   *  onIndexVaultError (failure) hooks — both guarded on `inFlight?.vault === vaultId`, since
   *  dispatch has no cross-call serialization and two index_vault calls on different vaults can
   *  genuinely overlap. This is a SINGLE slot, not a per-vault map: while two runs overlap, it
   *  reports "an" in-flight run (last onProgress wins), not "all" of them — see tool-wiring.ts's
   *  wireDomainTools for the ownership-guard reasoning. Plain in-memory — never written to SQLite. */
  inFlight: {
    vault: string;
    notesSeen: number;
    notesProcessed: number;
    chunksUpserted: number;
    startedAt: number;
  } | null;
}

export interface IndexResources {
  embeddingProvider: EmbeddingProvider;
  /** THE-683: the representation identity this boot computed, published so every downstream
   *  indexVault caller passes the SAME one instead of re-deriving it from loose config fields. */
  representation: RepresentationManifest;
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
  /** GH #995 fix round 2 (item B): the sticky-embeddings resolution this call applied, BEFORE
   *  constructing `embeddingProvider` or probing vec_chunks below — see this function's own doc
   *  comment. Every caller that used to compute its own (and has now had that call deleted as
   *  redundant — server-runtime.ts, cli/commands/index.ts) reads it from here instead, so boot and
   *  `index` cannot disagree about which resolution actually ran. */
  embeddingsSticky: StickyEmbeddingsResolution;
}

/**
 * Build the embedding provider, probe vec0/FTS5 availability, and construct the mutable index-health
 * tracker. THE-460: the vec0 fingerprint covers provider/model/dims + the fixed representation
 * constants + whether chunkContext enrichment is on, so a same-dimension model swap or an
 * enrichment/chunker change rebuilds vec_chunks instead of serving it stale. THE-291: the FTS5 probe
 * is false on adapters without FTS5 or when OBSIDIAN_TC_DISABLE_FTS=1.
 *
 * GH #995 fix round 2 (root cause, item B): this is the ONE construction choke point every
 * provider/index path goes through — boot (runtime/server-runtime.ts's wireRuntimeCore) AND
 * `obsidian-tc index` (cli/commands/index.ts) both call this, and nothing else in this codebase
 * calls `createEmbeddingProviderAsync` or `ensureVecChunks` directly. Applying sticky resolution
 * HERE, before either of those two calls, means a caller of THIS function can no longer forget to
 * resolve sticky first — the failure class the review found in `rerun.ts` (which reaches this
 * function transitively through `buildServerRuntime`, with no sticky call of its own) is closed by
 * construction, not by a caller-discovery test enumerating who currently remembers to call it.
 */
export async function wireIndexResources(deps: IndexResourcesDeps): Promise<IndexResources> {
  // Mutates `deps.embeddings` IN PLACE when it resolves to keep a different provider — the SAME
  // object reference the caller's `config.embeddings` is, so this is visible to every OTHER
  // consumer of that config the caller reads afterward (reranker/gateway wiring, job handlers),
  // exactly as it was when each caller applied this itself before this fix. Throws (never
  // constructs a guessed provider) when the kept identity is unmappable — see
  // embeddings/sticky-provider.ts's applyStickyEmbeddings, finding 4.
  const embeddingsSticky = applyStickyEmbeddings(
    { embeddings: deps.embeddings, vaults: deps.vaults },
    deps.db,
  );
  const embeddingProvider = await createEmbeddingProviderAsync(deps.embeddings, {
    configDir: deps.configDir,
    securityProfile: deps.securityProfile,
    cacheDir: deps.cacheDir,
    ...(deps.excludeFilter !== undefined ? { excludeFilter: deps.excludeFilter } : {}),
  });
  const embedConfig = {
    batchSize: deps.embeddings.batchSize,
    concurrency: deps.embeddings.concurrency,
    maxBatchTokens: deps.embeddings.maxBatchTokens,
  };
  // THE-683: the ONE derivation. This manifest is also handed to indexVault (IndexVaultArgs
  // .representation) rather than rebuilt there, so boot and the index_vault tool cannot compute
  // different identities for the same table — the unbounded-rebuild-loop hazard the old
  // hand-built pair carried, previously guarded only by a parity test.
  // THE-424: chunkTokens rides in alongside the embeddings block — it belongs to config.indexing,
  // but the manifest is one flat identity and this is its only derivation point.
  const representation = buildRepresentationManifest(embeddingProvider, {
    ...deps.embeddings,
    ...(deps.chunkTokens !== undefined ? { chunkTokens: deps.chunkTokens } : {}),
  });
  const hasVec = ensureVecChunks(deps.db, representation, {
    now: Date.now,
    onRebuild: deps.onVecRebuild,
    // Fix A: the backfill must match what chunk_embeddings.model actually stores.
    activeModel: embeddingProvider.id,
  });
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
    inFlight: null,
  };
  const recordIngestStatsFor = (vaultId: string, s: IndexStats): IndexStats => {
    recordIngestStats(deps.db, deps.metrics, vaultId, s);
    return s;
  };
  const indexVaultRecorded = (opts: IndexVaultArgs): Promise<IndexStats> =>
    indexVault(opts).then((s) => recordIngestStatsFor(opts.vaultId, s));

  return {
    embeddingProvider,
    representation,
    embedConfig,
    hasVec,
    hasFts,
    indexHealth,
    recordIngestStatsFor,
    indexVaultRecorded,
    embeddingsSticky,
  };
}

// --- Group B: wireIndexCoordinator ------------------------------------------------------------

export interface IndexCoordinatorDeps {
  db: Database;
  embeddingProvider: EmbeddingProvider;
  hasVec: boolean;
  /** THE-424: config.indexing.chunkTokens. Undefined -> the chunker's 512 default. */
  chunkTokens?: number;
  /** config.embeddings.chunkContext */
  chunkContext: boolean;
  /** config.indexing */
  indexing: { writeConcurrency: number; writeConcurrencyPerVault: number; queueMax: number };
  /** The CANONICAL vault roots (vaultRegistry.list(), not raw config.vaults — see
   *  server-runtime.ts's call site, THE-1081 review round), narrowed to what registerVaultWatch
   *  needs. */
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
  /** THE-934 fix round 1 (Blocking-1): egress.excludePaths, as a per-path predicate. Threaded
   *  into indexNote for EVERY write through this coordinator — write_note/append_note/patch_note,
   *  the vault watcher, and a move/rename INTO an excluded folder. Absent -> nothing excluded. */
  isEgressExcluded?: (rel: string) => boolean;
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
          deps.isEgressExcluded,
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
