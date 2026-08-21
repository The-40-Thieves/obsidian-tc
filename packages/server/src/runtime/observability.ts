// THE-466 slice 2: run_serve's observability wiring, extracted verbatim out of cli.ts (slice 1
// left this block deliberately in place — see cli.ts's header comment). This is the composition
// root for the Prometheus recorder, the MORGIANA emitter, and the plain-callback seams
// (onVecFallback / onStageMetric / sqlHooksFor) that the search and db layers take instead of
// importing a metrics module directly.
//
// THE-585 found three gauges that were declared in GaugeSources, registered a `# TYPE` line, and
// emitted no series at all for many releases, because the only construction site was buried
// inside a 1000+ line boot function where nothing could assert against it. Extracting this block
// is what makes "does a gauge's value reach the exposition" an assertable question again — see
// observability.test.ts.
//
// The index-coordinator and scheduler gauge sources read live objects that do not exist yet at
// the point run_serve constructs the recorder (indexCoordinator/scheduler are built later, after
// the tool registry). The caller passes lazy accessors instead — exactly the shape run_serve
// already used for `httpConstructSeconds` (a `let` assigned after the recorder reads it): each
// accessor is invoked only at scrape time, by which point boot has finished and the real object is
// live. Behaviour is identical to the inline closures this replaces.
import { writeEvent } from "../audit";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import {
  type ActivationRecomputeStats,
  registerActivationRecompute,
} from "../experiential/activation";
import { databaseGaugeSources } from "../metrics/gauge-sources";
import { MetricsRecorder } from "../metrics/registry";
import { MorgianaEmitter } from "../morgiana/emitter";
import type { Scheduler } from "../scheduler/scheduler";
import type { StageMetric } from "../search/graph_search_stages/instrumentation";
import type { IndexCoordinatorStats } from "../search/index-coordinator";
import type { RetrievalCaches } from "../search/query_cache";
import type { RerankOutcome } from "../search/rerank";
import type { VecRebuildEvent } from "../search/vec";

/** Bounded subsystem name used in the `vault` label where a metric is process-wide rather than
 *  per-vault — the precedent the query-cache gauges set ("results"/"vectors"). */
const SUBSYSTEM_COORDINATOR = "coordinator";

export interface ObservabilityDeps {
  db: Database;
  cacheDir: string;
  /** config.observability.morgiana.spool */
  morgianaSpool: boolean;
  /** THE-507: hoisted above the recorder in run_serve so its stats can be a gauge source. */
  retrievalCaches: RetrievalCaches;
  /** THE-585 (#1, #2): read lazily — indexCoordinator is constructed after the recorder. */
  getIndexCoordinatorStats: () => IndexCoordinatorStats;
  /** THE-585 (#9): read lazily — the scheduler is constructed after the recorder. */
  getSchedulerStats: () => ReturnType<Scheduler["stats"]>;
  /** THE-585 (#11): null until the HTTP transport is constructed (and forever, on a stdio-only
   *  server) — see the gauge source below. */
  getHttpConstructSeconds: () => number | null;
}

export interface Observability {
  metrics: MetricsRecorder;
  /** THE-585 (#7, #8): vec0 -> brute-force degradation counter. A plain callback so the search
   *  layer never imports the metrics recorder. */
  onVecFallback: (vault: string, reason: "error" | "underfill") => void;
  /** THE-585 (#6): retrieval stage duration + candidate funnel. Same seam shape as onVecFallback. */
  onStageMetric: (vault: string, metric: StageMetric) => void;
  /** one rerankWithScores decision (see MetricsRecorder.incRerankOutcome). Same seam
   *  shape as onVecFallback — the search layer never imports the metrics recorder. */
  onRerankOutcome: (vault: string, outcome: RerankOutcome) => void;
  /** THE-891 item 3: graph-walk ACL prune counter (see MetricsRecorder.incAclWalkPruned). Same
   *  seam shape as onVecFallback — the search layer never imports the metrics recorder. */
  onAclWalkPruned: (vault: string, count: number) => void;
  /** THE-645 item 1: registerActivationRecompute's onRecompute stats, routed to the recorder
   *  instead of discarded. Same seam shape as onVecFallback — the experiential layer never
   *  imports the metrics recorder. */
  onActivationRecompute: (vault: string, stats: ActivationRecomputeStats) => void;
  /** THE-612: ensureVecChunks' onRebuild, routed to the recorder. Same seam shape as
   *  onVecFallback — search/vec.ts never imports the metrics recorder. */
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** THE-585 (#5): bind a vault to the write-lock hooks. Same seam as onVecFallback — the db and
   *  indexer layers take plain callbacks and never import metrics, so the composition root stays
   *  the only module that knows a recorder exists. */
  sqlHooksFor: (vault: string) => WriteTxnHooks;
  morgiana: MorgianaEmitter;
  /** THE-603: captureSnapshot's no-op (config.snapshots.enabled false) is silent by design — the
   *  M1 write handlers call it unconditionally and get back null with no signal. Same seam shape
   *  as onVecFallback so notes-tools.ts never imports the audit module directly; best-effort like
   *  MorgianaEmitter's onDropped below, since observability must never break dispatch. */
  onSnapshotSkipped: (vaultId: string, path: string, op: string) => void;
}

/** Build the Prometheus recorder, its gauge sources, the metric-emitting callback seams, and the
 *  MORGIANA CloudEvents emitter. Everything here is read lazily at scrape/emit time — construction
 *  takes no snapshot — so extraction changes nothing about what gets measured or when. */
export function createObservability(deps: ObservabilityDeps): Observability {
  const cacheStat = (
    pick: (s: ReturnType<RetrievalCaches["results"]["stats"]>) => number,
  ): (() => Array<{ vault: string; value: number }>) => {
    // The label is the CACHE NAME, not a vault: the cache is process-wide and keyed internally by
    // vault, so there are no per-vault totals to report. Two bounded values, per the ticket's
    // bounded-labels constraint.
    return () => [
      { vault: "results", value: pick(deps.retrievalCaches.results.stats()) },
      { vault: "vectors", value: pick(deps.retrievalCaches.vectors.stats()) },
    ];
  };

  const metrics = new MetricsRecorder({
    // The DB-backed sources live in metrics/gauge-sources.ts so they are TESTABLE. Three of them
    // (sessions / capture queue / elicit tokens) were declared in GaugeSources and never wired,
    // emitting nothing for many releases — the only construction site was here, inside boot, where
    // no test could reach it. Extracting them is what keeps that fixed.
    ...databaseGaugeSources(deps.db),
    // THE-585 (#1): index-coordinator depth. Read from the coordinator's own stats() rather than
    // counted here, keeping the one-way dependency the composition root maintains.
    indexQueueDepth: () => [
      { vault: SUBSYSTEM_COORDINATOR, value: deps.getIndexCoordinatorStats().queued },
    ],
    indexActive: () =>
      Object.entries(deps.getIndexCoordinatorStats().perVaultActive).map(([vault, value]) => ({
        vault,
        value,
      })),
    // THE-585 (#2): coalesced writes. Process-wide like the queue depth above, so the same bounded
    // subsystem label.
    indexCoalesced: () => [
      { vault: SUBSYSTEM_COORDINATOR, value: deps.getIndexCoordinatorStats().coalesced },
    ],
    // THE-585 (#9): scheduler health. `vault` carries the bounded JOB NAME — the jobs are
    // registered in code at startup, so the label set is fixed by the build, not by traffic.
    schedulerSkipped: () =>
      deps.getSchedulerStats().map((j) => ({ vault: j.job, value: j.skipped })),
    schedulerConsecutiveFailures: () =>
      deps.getSchedulerStats().map((j) => ({ vault: j.job, value: j.consecutiveFailures })),
    schedulerDeferred: () =>
      deps.getSchedulerStats().map((j) => ({ vault: j.job, value: j.deferred })),
    // THE-585 (#11): boot-time HTTP construction. Stays an empty series until the transport is
    // actually started — a stdio-only server never constructs one, and reporting 0 there would
    // claim a measurement that never happened.
    httpConstructSeconds: () => {
      const seconds = deps.getHttpConstructSeconds();
      return seconds === null ? [] : [{ vault: "http", value: seconds }];
    },
    queryCacheHits: cacheStat((s) => s.hits),
    queryCacheMisses: cacheStat((s) => s.misses),
    queryCacheEvictions: cacheStat((s) => s.evictions),
    queryCacheExpirations: cacheStat((s) => s.expirations),
    // idempotencyCacheBytes (THE-197) moved into databaseGaugeSources above alongside the three it
    // was the only wired sibling of — keeping one here too would be a second copy of the same SQL.
  });
  // THE-585 (#7, #8): vec0 -> brute-force degradation counter. Defined here, next to the recorder,
  // so the search layer keeps taking a plain callback and never imports metrics.
  const onVecFallback = (vault: string, reason: "error" | "underfill"): void =>
    metrics.incVecFallback(vault, reason);
  // THE-585 (#6): retrieval stage duration + candidate funnel. Same seam shape as onVecFallback —
  // a plain callback, so the retrieval layer still never imports the metrics recorder.
  const onStageMetric = (vault: string, metric: StageMetric): void =>
    metrics.observeRetrievalStage(vault, metric);
  // same seam shape as onVecFallback/onStageMetric above.
  const onRerankOutcome = (vault: string, outcome: RerankOutcome): void =>
    metrics.incRerankOutcome(vault, outcome);
  // THE-891 item 3: graph-walk ACL prune counter. Same seam shape as onVecFallback/onStageMetric.
  const onAclWalkPruned = (vault: string, count: number): void =>
    metrics.incAclWalkPruned(vault, count);
  // THE-645 item 1: same seam shape as onVecFallback/onStageMetric above.
  const onActivationRecompute = (vault: string, stats: ActivationRecomputeStats): void =>
    metrics.incActivationRecomputeChunks(vault, stats.chunks);
  // THE-612: same seam shape as onVecFallback above.
  const onVecRebuild = (event: VecRebuildEvent): void => metrics.incVecRebuild(event.reason);
  // THE-585 (#5): bind a vault to the write-lock hooks. Same seam as onVecFallback — the db and
  // indexer layers take plain callbacks and never import metrics, so the composition root stays
  // the only module that knows a recorder exists. `vault` is a real vault id for the index paths;
  // process-wide subsystems pass a bounded subsystem name instead (see observeSqlLockWait).
  const sqlHooksFor = (vault: string): WriteTxnHooks => ({
    onLockWait: (txn, seconds) => metrics.observeSqlLockWait(vault, txn, seconds),
    onBusy: (txn, reason) => metrics.incSqlBusy(vault, txn, reason),
  });
  // MORGIANA CloudEvents spool (G2.4) — JSONL by default; a dropped event feeds
  // morgiana_emit_dropped_total + the event_log and never blocks a tool call.
  const morgiana = new MorgianaEmitter({
    cacheDir: deps.cacheDir,
    spool: deps.morgianaSpool,
    onDropped: (vaultId, reason) => {
      metrics.incMorgianaDropped(vaultId, reason);
      try {
        writeEvent(deps.db, {
          ts: Date.now(),
          vault_id: vaultId,
          status: "skipped",
          error_code: reason,
          event_type: "morgiana_emit_dropped",
        });
      } catch {
        /* event_log is best-effort */
      }
    },
  });

  // THE-603/THE-648: make the snapshot-on-write no-op legible instead of silent. Fires only when
  // a destructive patch_note replace ran with snapshots disabled (config.snapshots.enabled false
  // — an explicit opt-out from the now-on-by-default "trusted-local" posture) — never
  // load-bearing, so a write_event failure here must not surface to the caller. `path` is
  // accepted for callers/tests that want it, but event_log
  // has no path column (see 20260519_001_initial.sql) — vault_id + tool_name is what it can carry.
  const onSnapshotSkipped = (vaultId: string, _path: string, op: string): void => {
    try {
      writeEvent(deps.db, {
        ts: Date.now(),
        vault_id: vaultId,
        tool_name: op,
        status: "skipped",
        error_code: "snapshots_disabled",
        event_type: "snapshot_skipped",
      });
    } catch {
      /* event_log is best-effort */
    }
  };

  return {
    metrics,
    onVecFallback,
    onStageMetric,
    onRerankOutcome,
    onAclWalkPruned,
    onActivationRecompute,
    onVecRebuild,
    sqlHooksFor,
    morgiana,
    onSnapshotSkipped,
  };
}

/**
 * THE-645 item 1: registers the periodic activation recompute with its onRecompute/onError
 * already bound to `observability` — cli.ts was the only construction site AND the only place
 * that could have reported the stats registerActivationRecompute already computed every tick, so
 * they were silently discarded. Same "wiring lives next to the thing it wires" shape as
 * maintenance-wiring.ts's configureMaintenance, kept here (not there) because the only new
 * behaviour is a metrics emission — `observability` already owns that seam.
 */
export function wireActivationRecompute(
  scheduler: Scheduler,
  observability: Pick<Observability, "onActivationRecompute">,
  deps: { edb: Database; intervalMs: number; decay?: number | undefined },
): void {
  registerActivationRecompute(scheduler, {
    edb: deps.edb,
    intervalMs: deps.intervalMs,
    // THE-644 item 3: forwarded only when set, so an absent config key leaves
    // `recomputeActivation`'s own default in charge rather than pinning it here. Every layer below
    // already accepted a decay; this wiring was the one link that dropped it.
    ...(deps.decay !== undefined ? { decay: deps.decay } : {}),
    onRecompute: (stats) => observability.onActivationRecompute("activation-recompute", stats),
    onError: (e) =>
      process.stderr.write(
        `[activation-recompute] ${e instanceof Error ? e.message : String(e)}\n`,
      ),
  });
}
