// run_serve's index-on-write wiring, extracted verbatim out of cli.ts. Split into TWO exported
// functions rather than one, because the source order they extract from is not contiguous:
// `wireIndexResources` (the embedding provider, the vec0/FTS probes, the mutable indexHealth
// tracker) sits BEFORE cli.ts's job-queue/gateway construction and the inline health/index_status
// tool registrations; `wireIndexCoordinator` (the coordinator, the reindex/deindex hooks, the
// vault watcher) sits AFTER them, because its write handler needs `makeOnIndexed`, which depends
// on the job queue and gateway roles cli.ts still owns. Moving either to close that gap would
// reorder real side-effecting boot steps. See server-runtime.ts for why only `wireIndexResources`
// is folded into the argv-free composition entry.

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
import { EXCLUDED_DISMISS_REASON, type VaultExclusion } from "../search/index-exclusion";
import {
  deindexNote,
  hasIndexedState,
  type IndexHook,
  type IndexStats,
  type IndexVaultArgs,
  indexNote,
  indexVault,
} from "../search/indexer";
import { buildRepresentationManifest, type RepresentationManifest } from "../search/representation";
import { ensureVecChunks, type VecRebuildEvent } from "../search/vec";
import { isHardLinkedFile, resolveVaultPathChecked } from "../vault/paths";
import { ACL_PATH_UNRESOLVED } from "../vault/stored-acl-path";
import { registerVaultWatch } from "../vault/watcher";
import {
  applyIndexWriteError,
  clearFrontmatterFailure,
  type FrontmatterFailure,
} from "./index-write-outcome";

// --- Group A: wireIndexResources -------------------------------------------------------------

export interface IndexResourcesDeps {
  db: Database;
  metrics: MetricsRecorder;
  /** config.embeddings. `onProviderChange` is required (not part of the narrower
   *  `EmbeddingsConfigLike`) because sticky resolution applies HERE (see this function's own doc
   *  comment) and `resolveStickyEmbeddings` needs it. Every real caller passes the actual
   *  `config.embeddings`, which always carries it (schema default "keep"). */
  embeddings: EmbeddingsConfigLike & {
    batchSize: number;
    concurrency: number;
    maxBatchTokens: number;
    chunkContext: boolean;
    onProviderChange: "keep" | "switch";
  };
  /** config.vaults, narrowed to the id every sticky-resolution query needs — required so
   *  `wireIndexResources` can apply sticky resolution itself rather than relying on every caller
   *  to have done so first. */
  vaults: ReadonlyArray<{ id: string }>;
  /** ensureVecChunks' onRebuild, routed to the metrics recorder by runtime/observability.ts. */
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** `dirname(configPath)` — the trust root for embeddings.modulePath. NOT undefined in
   *  zero-config vault-path mode, only when `configPath` itself is absent (providers/types.ts). */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
  /** config.cacheDir. Threaded into createEmbeddingProviderAsync so the "local" embeddings entry
   *  fetches its pinned model weights under `<cacheDir>/models/embedder-local/` rather than
   *  falling back to a CWD-relative default. Optional so a caller that predates this keeps working. */
  cacheDir?: string;
  /** config.indexing.chunkTokens. Lives on `indexing` rather than `embeddings`, so it is threaded
   *  in beside the embeddings block — but must reach the manifest, since this is the ONE place a
   *  representation identity is derived. Optional so a caller that predates it keeps the default. */
  chunkTokens?: number;
  /** config.egress.excludePaths, compiled. Threaded into createEmbeddingProviderAsync — the
   *  embedding PORT — so the provider this returns is guarded before ANY consumer sees it. Absent
   *  -> excludes nothing. */
  excludeFilter?: EgressFilter;
}

/** Mutable index-health tracker surfaced by server_health. reconcile flips pending -> ok/degraded
 *  when the boot reconcile settles; writeFailures counts swallowed index-on-write errors. The
 *  health tool reads a snapshot at call time. */
export interface IndexHealthState {
  reconcile: "pending" | "ok" | "degraded";
  reconcileAt: number | null;
  reconcileErrors: Array<{ vault: string; error: string }>;
  writeFailures: number;
  lastWriteError?: string;
  /** Notes whose latest index-on-write hit bad frontmatter YAML; not writeFailures (no stall alert). */
  frontmatterFailures: Map<string, FrontmatterFailure>;
  lastFrontmatterFailure?: FrontmatterFailure;
  /** THE-291: the notes/FTS metadata pass completed (independent of embed success). */
  notesReady: boolean;
  /** THE-457: fail-open audit writes that threw (locked DB / disk full) — the audit trail is lossy. */
  auditWriteFailures: number;
  /** THE-458 (audit #5): times the index-on-write queue depth crossed queueMax (backpressure edges). */
  indexQueueBackpressures: number;
  /** chunks_upserted from the most recent index_vault tool call; null until the first one this
   *  process (get_index_status surfaces it verbatim). */
  lastChunksUpserted: number | null;
  /** Set while an index_vault call is in flight, cleared in the tool's onIndexVaultComplete/
   *  onIndexVaultError hooks — both guarded on `inFlight?.vault === vaultId`, since two index_vault
   *  calls on different vaults can genuinely overlap. A SINGLE slot, not a per-vault map: while two
   *  runs overlap this reports "an" in-flight run, not "all" of them. Plain in-memory. */
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
  /** The representation identity this boot computed, published so every downstream indexVault
   *  caller passes the SAME one instead of re-deriving it from loose config fields. */
  representation: RepresentationManifest;
  /** The embed-batch knobs, threaded into every reconcile so local runners are tunable. */
  embedConfig: { batchSize: number; concurrency: number; maxBatchTokens: number };
  hasVec: boolean;
  hasFts: boolean;
  indexHealth: IndexHealthState;
  /** Routes a real IndexStats pass to the Prometheus counters — importable and testable directly. */
  recordIngestStatsFor: (vaultId: string, s: IndexStats) => IndexStats;
  /** Routes every direct indexVault(...) caller through the recorder instead of a per-call-site
   *  reminder. */
  indexVaultRecorded: (opts: IndexVaultArgs) => Promise<IndexStats>;
  /** The sticky-embeddings resolution this call applied, BEFORE constructing `embeddingProvider` or
   *  probing vec_chunks below — every caller that used to compute its own reads it from here
   *  instead, so boot and `index` cannot disagree about which resolution actually ran. */
  embeddingsSticky: StickyEmbeddingsResolution;
}

/**
 * Build the embedding provider, probe vec0/FTS5 availability, and construct the mutable index-health
 * tracker. The vec0 fingerprint covers provider/model/dims + the fixed representation constants +
 * whether chunkContext enrichment is on, so a same-dimension model swap or an enrichment/chunker
 * change rebuilds vec_chunks instead of serving it stale. The FTS5 probe
 * is false on adapters without FTS5 or when OBSIDIAN_TC_DISABLE_FTS=1.
 *
 * GH #995: this is the ONE construction choke point every provider/index path goes through —
 * boot (server-runtime.ts's wireRuntimeCore) AND `obsidian-tc index` (cli/commands/index.ts) both
 * call this, and nothing else in this codebase calls `createEmbeddingProviderAsync` or
 * `ensureVecChunks` directly. Applying sticky resolution HERE, before either of those two calls,
 * means a caller of THIS function can no longer forget to resolve sticky first — closed by
 * construction, not by a caller-discovery test enumerating who currently remembers to call it.
 */
export async function wireIndexResources(deps: IndexResourcesDeps): Promise<IndexResources> {
  // Mutates `deps.embeddings` IN PLACE when it resolves to keep a different provider — the SAME
  // object reference the caller's `config.embeddings` is, so this is visible to every OTHER
  // consumer of that config the caller reads afterward. Throws (never constructs a guessed
  // provider) when the kept identity is unmappable — see applyStickyEmbeddings.
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
  // The ONE derivation. This manifest is also handed to indexVault (IndexVaultArgs.representation)
  // rather than rebuilt there, so boot and the index_vault tool cannot compute different
  // identities for the same table. chunkTokens rides in alongside the embeddings block — it
  // belongs to config.indexing, but the manifest is one flat identity.
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
    frontmatterFailures: new Map(),
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
  /** The CANONICAL vault roots (vaultRegistry.list(), not raw config.vaults), narrowed to what
   *  registerVaultWatch needs. */
  vaults: readonly { id: string; path: string }[];
  /** A vault's live canonical root (a runtime add_vault is seen); falls back to `vaults`. The
   *  ACL identity of an index-on-write note is resolved against it. */
  rootOf?: (vaultId: string) => string | undefined;
  /** config.watch */
  watch: { enabled: boolean; debounceMs: number };
  sqlHooksFor: (vault: string) => WriteTxnHooks;
  /** Bumps indexHealth's write-failure and backpressure counters — the SAME indexHealth
   *  `wireIndexResources` constructed, threaded in as a value. */
  indexHealth: Pick<
    IndexHealthState,
    | "writeFailures"
    | "lastWriteError"
    | "indexQueueBackpressures"
    | "frontmatterFailures"
    | "lastFrontmatterFailure"
  >;
  metrics: MetricsRecorder;
  /** Root ACL + per-vault overrides, owned by governance. */
  acl: FolderAcl;
  aclByVault: Map<string, FolderAcl>;
  /** onIndexed hook -> contradiction-check enqueue. Owned by cli.ts (needs the job queue + gateway
   *  roles) and passed in as a plain function — this module never constructs a job queue or a
   *  gateway client. */
  makeOnIndexed: (vaultId: string) => IndexHook | undefined;
  /** egress.excludePaths, as a per-path predicate. Threaded into indexNote for EVERY write through
   *  this coordinator. Absent -> nothing excluded. */
  isEgressExcluded?: (rel: string) => boolean;
  indexExclusionFor?: (vaultId: string) => VaultExclusion;
  onVaultConfigChange?: (vaultId: string) => void;
  /** GH #995: gates ONLY the vault WATCHER's onUpsert/onDelete callbacks below — never
   *  `reindexHook`/`deindexHook` themselves, which stay reachable for explicit tool writes and
   *  this process's OWN writes on every role. Absent behaves as "always leader" — a single-process
   *  deployment never gates anything. See src/runtime/vault-lock.ts for what elects the leader. */
  isLeader?: () => boolean;
  /** Fires on every demote — drops pending watcher-originated coordinator ops. */
  onDemote?: (cb: (reason: string) => void) => void;
}

export interface IndexCoordinatorWiring {
  indexCoordinator: IndexCoordinator;
  /** Per-vault ACL read-visibility filter shared by the boot reconcile, runtime add_vault, AND the
   *  index-on-write hook below. */
  indexReadableFor: (vaultId: string) => (rel: string) => boolean;
  reindexHook: (vaultId: string, path: string, content: string) => void;
  deindexHook: (vaultId: string, path: string) => void;
  /** Stops the filesystem watch — idempotent, the only resource this wiring step owns that
   *  outlives its own construction. */
  stopVaultWatch: () => void;
}

/**
 * Routes every index-on-write mutation through a per-(vault,path) coordinator so same-path
 * writes/deletes serialize (newest wins) while different paths stay concurrent, and feeds the SAME
 * reindexHook the write path uses into the vault watcher, so a watched change is read-ACL-gated
 * identically to a write_note.
 */
export function wireIndexCoordinator(deps: IndexCoordinatorDeps): IndexCoordinatorWiring {
  // The ACL identity of a written path (vault/paths.ts resolveVaultPathChecked), which differs from
  // the path through a symlinked folder: the gate and the stored row both judge THAT, never the
  // name. null = cannot be resolved (unknown root, escape): the row is stored unresolved, which no
  // reader sees until a pass resolves it.
  const aclRelFor = (vaultId: string, path: string): string | null => {
    const root = deps.rootOf?.(vaultId) ?? deps.vaults.find((v) => v.id === vaultId)?.path;
    if (root === undefined) return null;
    try {
      const resolved = resolveVaultPathChecked(root, path);
      // read_note refuses a hard-linked file, so it has no identity to authorize on: stored closed.
      return isHardLinkedFile(resolved.abs) ? null : resolved.aclRel;
    } catch {
      return null;
    }
  };
  const deindexPath = (vaultId: string, path: string, excluded: boolean): void =>
    deindexNote(
      deps.db,
      vaultId,
      path,
      deps.hasVec,
      deps.chunkContext,
      deps.sqlHooksFor(vaultId),
      Date.now,
      excluded ? EXCLUDED_DISMISS_REASON : undefined,
    );
  const isExcludedPath = (vaultId: string, path: string): boolean =>
    deps.indexExclusionFor?.(vaultId).isExcluded(path) === true;
  const indexCoordinator = new IndexCoordinator(
    {
      write: (vaultId, path, content) => {
        if (isExcludedPath(vaultId, path)) {
          if (hasIndexedState(deps.db, vaultId, path)) deindexPath(vaultId, path, true);
          return undefined;
        }
        return indexNote(
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
          aclRelFor(vaultId, path) ?? ACL_PATH_UNRESOLVED,
        );
      },
      delete: (vaultId, path) => deindexPath(vaultId, path, isExcludedPath(vaultId, path)),
      onError: (e, vaultId, path) =>
        applyIndexWriteError(e, vaultId, path, deps.indexHealth, {
          db: deps.db,
          metrics: deps.metrics,
          write: (m) => process.stderr.write(m),
        }),
      onApplied: (vaultId, path) => clearFrontmatterFailure(deps.indexHealth, vaultId, path),
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
  // The index-on-write gate decides on the written path's ACL identity, as index_vault does for a
  // walked note (aclRel): a write through `wiki -> private` is judged as `private/...`. A path that
  // cannot be resolved keeps the lexical answer (the row is stored unresolved either way).
  const indexReadableByIdentity =
    (vaultId: string): ((rel: string) => boolean) =>
    (rel) =>
      indexReadableFor(vaultId)(aclRelFor(vaultId, rel) ?? rel);
  // THE-453 (runtime): a write-allowed but read-denied path (writePaths ⊃ readPaths) must not be
  // embedded — makeReindexGate routes it to submitDelete instead of submitWrite. Deletes are always
  // safe, so deindex stays a direct submitDelete.
  const reindexHook = makeReindexGate(indexReadableByIdentity, {
    write: (vaultId, path, content) => indexCoordinator.submitWrite(vaultId, path, content),
    delete: (vaultId, path) => indexCoordinator.submitDelete(vaultId, path),
  });
  const deindexHook = (vaultId: string, path: string): void =>
    indexCoordinator.submitDelete(vaultId, path);
  // F1 (fix round 2): a SEPARATE ACL-gated hook pair tagged "watcher" so a demote can cancel only
  // these pending ops (cancelOrigin), leaving an explicit tool write on the same key untouched.
  const watcherReindexHook = makeReindexGate(indexReadableByIdentity, {
    write: (vaultId, path, content) =>
      indexCoordinator.submitWrite(vaultId, path, content, "watcher"),
    delete: (vaultId, path) => indexCoordinator.submitDelete(vaultId, path, "watcher"),
  });
  const watcherDeindexHook = (vaultId: string, path: string): void =>
    indexCoordinator.submitDelete(vaultId, path, "watcher");
  // GH #995: the watcher itself keeps running in EVERY process (leader and follower alike — a
  // follower still needs to serve reads off a live index once it eventually promotes, and
  // stopping/restarting the underlying fs watch on every role flip would be strictly more moving
  // parts than gating the two callbacks it drives). Only the WRITE side is gated: a follower's
  // onUpsert/onDelete for a change it sees is a deliberate no-op, never queued for later replay —
  // the promotion-triggered reconcile pass (server-runtime.ts) is what catches up anything a
  // follower's watcher window missed while it wasn't leader, via a fresh content-hash walk.
  const isLeader = deps.isLeader ?? (() => true);
  const stopVaultWatch = registerVaultWatch(deps.vaults, deps.watch, {
    onUpsert: (vaultId, path, content) => {
      if (isLeader()) watcherReindexHook(vaultId, path, content);
    },
    onDelete: (vaultId, path) => {
      if (isLeader()) watcherDeindexHook(vaultId, path);
    },
    ...(deps.onVaultConfigChange
      ? {
          onVaultConfigChange: (vaultId: string) => {
            if (isLeader()) deps.onVaultConfigChange?.(vaultId);
          },
        }
      : {}),
  });

  // F1 (fix round 2): drop pending watcher ops on demote (explicit tool writes stay untouched).
  deps.onDemote?.(() => indexCoordinator.cancelOrigin("watcher"));

  return { indexCoordinator, indexReadableFor, reindexHook, deindexHook, stopVaultWatch };
}
