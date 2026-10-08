// THE-466 slice 3 (opened by THE-649): run_serve's maintenance-sweep wiring, moved out of cli.ts
// for the same reason slice 2 moved the observability block — it was boot-only composition buried
// inside a 1000+ line function, so nothing could assert against it.
//
// The specific thing that becomes assertable here is the sweep's REPORTING, which has drifted
// twice. THE-571 added the `jobs` arm and THE-610 added `trace_files`, and each time the emitted
// total had to be widened to include the new arm or a sweep that pruned only that kind would report
// zero and read as a no-op. `Object.values(counts)` is what makes a future arm counted for free;
// this file is where that claim can now be tested rather than asserted in a comment.
//
// Extracted verbatim: the run body, the emit, the best-effort event_log write and the stderr error
// routing are unchanged from the inline block in cli.ts.
import { writeEvent } from "../audit";
import { registerMaintenanceSweep, type SweepCounts } from "../db/maintenance";
import {
  MEMORY_ORPHAN_CLASSES,
  type MemoryOrphanClass,
  type MemoryOrphanCounts,
  registerMemoryOrphanSweep,
} from "../db/memory-orphans";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { MorgianaEmitter } from "../morgiana/emitter";
import { registerSpoolSweep, type SpoolSweepCounts } from "../morgiana/spool-sweep";
import type { SignerSource } from "../provenance/signer";
import type { Scheduler } from "../scheduler/scheduler";
import type { FolderPins } from "../vault/folder-links";
import { resolveCacheTraceDir, resolveTraceDirs } from "../workspace/sessions";

export interface MaintenanceWiringDeps {
  db: Database;
  /** THE-737: trace storage root, so the sweep prunes the new location too. */
  cacheDir: string;
  /** config.maintenance */
  maintenance: {
    enabled: boolean;
    intervalMinutes: number;
    jobsCompleteRetentionDays: number;
    jobsFailedRetentionDays: number;
    episodesRetentionDays: number;
    retrievalsRetentionDays: number;
    /** maintenance.captureQueueRetentionDays — see db/maintenance.ts's sweepCaptureQueue. */
    captureQueueRetentionDays: number;
    /** maintenance.memoryOrphans — see db/memory-orphans.ts. Absent -> that job is not registered. */
    memoryOrphans?: {
      enabled: boolean;
      intervalMs: number;
      batchSize: number;
      retiredRetentionDays?: number | undefined;
      removedVaultRetentionDays?: number | undefined;
      dryRun: boolean;
    };
  };
  /** config.observability.retention. The two spool keys are optional: absent (or 0 and unset) ->
   *  the spool sweep is not registered. */
  retention: {
    eventLogDays: number;
    tracesDays: number;
    spoolRetentionDays?: number;
    spoolMaxBytes?: number | undefined;
  };
  /** config.experiential — THE-891 item 1: content-axis retention, orthogonal to
   *  maintenance.episodesRetentionDays above (that governs row deletion; this governs
   *  args_json redaction). Absent leaves the redaction arm unarmed, same as every other
   *  optional experiential-adjacent field here. */
  experiential?: { captureRetentionDays: number };
  /** config.sessions — THE-726. Absent, or autoOpen false, leaves the implicit-session arm
   *  unarmed. THE-1108: `maxExplicitLifetimeSeconds` arms a SEPARATE arm that is not gated on
   *  `autoOpen` — see this file's `configureMaintenance` for why. */
  sessions?: { autoOpen: boolean; windowSeconds: number; maxExplicitLifetimeSeconds: number };
  /** THE-1108 fix: invoked once per explicit session the sweep actually closes, so the composition
   *  root can clear its own process-local `ActiveSessionTracker` entry — the tracker has no other
   *  way to learn a row closed by this sweep's SQL rather than by `end_session`. Absent -> no
   *  callback, unchanged behavior (e.g. a caller with no in-process tracker to clear). */
  onExplicitSessionClosed?: (row: { id: string; principal: string | null }) => void;
  /** The CANONICAL vault roots (vaultRegistry-resolved `.root`, not raw config.vaults — see
   *  server-runtime.ts's wireScheduler call site, THE-1081 review round 2), other fields (e.g.
   *  `workspace`) preserved from config. Trace dirs are per-vault and resolved with containment
   *  checking (THE-610) via resolveTraceDirs -> resolveVaultPathChecked, which now refuses a root
   *  whose final path component is a symlink UNLESS it is the registry's own canonical form (see
   *  vault/paths.ts) — a raw config path here would make `serve` fail to start on the common case
   *  of a vault root that is itself a symlink (iCloud/Dropbox/NAS sync target). Field named
   *  `root`, not `path`, to match resolveTraceDirs's own parameter — see its doc comment. */
  vaults: readonly { id: string; root: string; workspace?: { traceFolder: string } }[];
  /** The vault registry's folder pins. The trace sweep deletes files inside a vault outside any
   *  dispatch, so it carries them itself and deletes through the pin (db/maintenance.ts). Absent ->
   *  the legacy unpinned sweep (a unit test with no registry). */
  folderPins?: FolderPins;
  defaultTraceFolder: string;
  /** The auth registry, when this process opened one: the sweep persists elapsed signing-key
   *  grace windows through it. Absent -> that arm is not armed (no registry, nothing to reap). */
  authRegistry?: { reapRetired(): number; reapExpiredTokens?(): number };
  /** oauth.db housekeeping (`gcOauthDb`), when the bundled authorization server opened its store.
   *  Absent -> that arm is not armed. */
  reapOauthDb?: () => number;
  /** config.provenance.retentionDays plus the recorder's live signer source (a rotation is picked
   *  up by the next prune). Absent -> the provenance arm is not armed: rows are kept forever. */
  provenanceRetention?: { days: number; signer: SignerSource; hooks?: WriteTxnHooks };
  /** THE-610 arm 2: the experiential.db handle, when the membrane is open. Absent -> both
   *  experiential arms skip and report 0, which is correct when there is nothing to sweep. */
  edb?: Database;
  morgiana: MorgianaEmitter;
  /** The LIVE vault ids (config vaults plus any added by add_vault), read at each memory orphan
   *  sweep. Absent -> the removed-vault class never runs. */
  listVaultIds?: () => readonly string[];
  /** Write-lock hooks for the memory orphan sweep's batches. */
  memoryOrphanSqlHooks?: WriteTxnHooks;
  /** Counter sinks for the memory orphan and spool sweeps. Absent -> counts are logged but not exported. */
  metrics?: {
    incMemoryOrphansSwept(cls: MemoryOrphanClass, n: number): void;
    incMorgianaSpoolPruned(reason: "age" | "size", n: number): void;
  };
  /** Vault id the process-wide sweep event is attributed to (run_serve's first vault). */
  eventVaultId: string;
  now?: () => number;
}

/** Total pruned across EVERY NUMERIC arm. Split out so the "a new arm is counted for free" claim
 *  is a callable function rather than a comment — see maintenance-wiring.test.ts.
 *
 *  THE-1039: `fts_merged` (the tables an FTS5 merge touched) is a `string[]`, not a row count —
 *  summing `Object.values` unfiltered would silently degrade to string concatenation the moment
 *  it joined the mix. Excluded by NAME rather than by `typeof v === "number"`, so a future
 *  numeric arm still joins the total automatically without this function changing again. */
type AuthReaper = { reapRetired(): number; reapExpiredTokens?(): number };

/** The sweep's auth.db arm: persist elapsed key windows (the count the sweep reports), and drop
 *  token records a day past their `exp`. The second is best-effort and must not turn the first's
 *  count into a failure: nothing verifies against either. */
function reapAuthRegistry(registry: AuthReaper): number {
  const retired = registry.reapRetired();
  try {
    registry.reapExpiredTokens?.();
  } catch (e) {
    process.stderr.write(
      `auth: could not drop expired token records: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  return retired;
}

export function sweepTotal(counts: SweepCounts): number {
  const { fts_merged: _fts_merged, ...numeric } = counts;
  return Object.values(numeric).reduce((a, b) => a + b, 0);
}

/**
 * THE-292: register the periodic cache.db maintenance sweep on the shared scheduler — purge expired
 * idempotency/elicit rows, trim event_log to its configured retention, prune terminal job rows and
 * aged trace files, then PRAGMA optimize.
 *
 * Best-effort by design: expired rows stay lazily rejected on read regardless, so a failed sweep
 * degrades disk reclamation, never correctness. Returns whether it registered, so a caller can tell
 * "disabled by config" from "registered" without re-reading the config.
 */
export function configureMaintenance(scheduler: Scheduler, deps: MaintenanceWiringDeps): boolean {
  if (!deps.maintenance.enabled) return false;
  configureMemoryOrphanSweep(scheduler, deps);
  configureSpoolSweep(scheduler, deps);
  registerMaintenanceSweep(scheduler, {
    db: deps.db,
    intervalMs: deps.maintenance.intervalMinutes * 60_000,
    eventLogDays: deps.retention.eventLogDays,
    jobsCompleteDays: deps.maintenance.jobsCompleteRetentionDays,
    jobsFailedDays: deps.maintenance.jobsFailedRetentionDays,
    captureQueueRetentionDays: deps.maintenance.captureQueueRetentionDays,
    tracesDays: deps.retention.tracesDays,
    // THE-737: sweep BOTH generations -- the cacheDir directory new sessions write to, and
    // the legacy per-vault dirs that still hold pre-migration traces.
    traceDirs: [
      resolveCacheTraceDir(deps.cacheDir),
      ...resolveTraceDirs(deps.vaults, deps.defaultTraceFolder, deps.folderPins),
    ],
    ...(deps.edb !== undefined
      ? {
          edb: deps.edb,
          episodesDays: deps.maintenance.episodesRetentionDays,
          retrievalsDays: deps.maintenance.retrievalsRetentionDays,
          // THE-891 item 1: only armed when the caller supplied config.experiential — mirrors the
          // sessions.autoOpen gating below, so a caller that omits the block gets no redaction arm
          // rather than a crash on a missing field.
          ...(deps.experiential !== undefined
            ? { captureRetentionDays: deps.experiential.captureRetentionDays }
            : {}),
        }
      : {}),
    // THE-726: only pass the window when autoOpen is on. Passing it unconditionally would arm a
    // sweep arm against sessions that cannot exist, and — worse — would silently start closing
    // `caller IS NULL` rows if any other writer ever produced that shape.
    ...(deps.sessions?.autoOpen === true
      ? { sessionWindowSeconds: deps.sessions.windowSeconds }
      : {}),
    // THE-1108: NOT gated on autoOpen — an explicit session comes from a client calling
    // start_session, which is possible whether or not the server ever opens one of its own, so
    // this arm arms whenever a sessions block is supplied at all.
    ...(deps.sessions !== undefined
      ? { sessionMaxExplicitLifetimeSeconds: deps.sessions.maxExplicitLifetimeSeconds }
      : {}),
    ...(deps.onExplicitSessionClosed !== undefined
      ? { onExplicitSessionClosed: deps.onExplicitSessionClosed }
      : {}),
    ...(deps.authRegistry !== undefined
      ? { reapAuthKeys: () => reapAuthRegistry(deps.authRegistry as AuthReaper) }
      : {}),
    ...(deps.reapOauthDb !== undefined ? { reapOauthDb: deps.reapOauthDb } : {}),
    ...(deps.provenanceRetention !== undefined
      ? { provenanceRetention: deps.provenanceRetention }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    onSweep: (counts) => {
      const total = sweepTotal(counts);
      // THE-1039: `rows_dropped` is MorgianaEventDataSchema's `record<string, number>` — a table
      // that got an FTS5 merge is not a row dropped, and `fts_merged` (string[]) does not fit the
      // schema's value type anyway. Excluded here the same way sweepTotal excludes it from the sum.
      const { fts_merged: _fts_merged, ...rowsDropped } = counts;
      deps.morgiana.emit(deps.eventVaultId, "tc.maintenance.sweep", {
        count: total,
        rows_dropped: rowsDropped,
      });
      try {
        writeEvent(deps.db, {
          ts: (deps.now ?? Date.now)(),
          status: "ok",
          event_type: "sweep_run",
          result_size: total,
        });
      } catch {
        /* event_log is best-effort */
      }
    },
    onError: (e) => {
      process.stderr.write(
        `[maintenance] sweep failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    },
  });
  return true;
}

/** One stderr line per sweep: counts and mode only, never row content. */
function logMemoryOrphanSweep(c: MemoryOrphanCounts): void {
  const parts = MEMORY_ORPHAN_CLASSES.map((k) => `${k}=${c[k]}`).join(" ");
  process.stderr.write(
    `[maintenance] memory orphan sweep${c.dry_run ? " (dry run)" : ""}: ${parts} batches=${c.batches}${c.truncated ? " truncated" : ""}\n`,
  );
}

/** Register the memory orphan sweep as its own job. Not registered when
 *  `maintenance.memoryOrphans.enabled` is false or the block is absent. */
function configureMemoryOrphanSweep(scheduler: Scheduler, deps: MaintenanceWiringDeps): void {
  const cfg = deps.maintenance.memoryOrphans;
  if (cfg === undefined || !cfg.enabled) return;
  registerMemoryOrphanSweep(scheduler, {
    db: deps.db,
    intervalMs: cfg.intervalMs,
    batchSize: cfg.batchSize,
    dryRun: cfg.dryRun,
    ...(cfg.retiredRetentionDays !== undefined
      ? { retiredRetentionDays: cfg.retiredRetentionDays }
      : {}),
    ...(cfg.removedVaultRetentionDays !== undefined
      ? { removedVaultRetentionDays: cfg.removedVaultRetentionDays }
      : {}),
    ...(deps.listVaultIds !== undefined ? { listVaultIds: deps.listVaultIds } : {}),
    ...(deps.memoryOrphanSqlHooks !== undefined ? { hooks: deps.memoryOrphanSqlHooks } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    onSweep: (counts) => {
      logMemoryOrphanSweep(counts);
      if (counts.dry_run) return;
      for (const k of MEMORY_ORPHAN_CLASSES) deps.metrics?.incMemoryOrphansSwept(k, counts[k]);
    },
    onError: (e) => {
      process.stderr.write(
        `[maintenance] memory orphan sweep failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    },
  });
}

/** One stderr line per sweep: counts only. */
function logSpoolSweep(c: SpoolSweepCounts): void {
  process.stderr.write(
    `[maintenance] morgiana spool sweep: files_age=${c.files_age} files_size=${c.files_size} bytes=${c.bytes}\n`,
  );
}

/** Register the morgiana spool retention sweep as its own job, on the maintenance interval. Not
 *  registered when neither bound is set (spoolRetentionDays absent or 0, and no spoolMaxBytes). */
function configureSpoolSweep(scheduler: Scheduler, deps: MaintenanceWiringDeps): void {
  const { spoolRetentionDays = 0, spoolMaxBytes } = deps.retention;
  if (spoolRetentionDays === 0 && spoolMaxBytes === undefined) return;
  registerSpoolSweep(scheduler, {
    cacheDir: deps.cacheDir,
    intervalMs: deps.maintenance.intervalMinutes * 60_000,
    retentionDays: spoolRetentionDays,
    ...(spoolMaxBytes !== undefined ? { maxBytes: spoolMaxBytes } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    onSweep: (counts) => {
      logSpoolSweep(counts);
      deps.metrics?.incMorgianaSpoolPruned("age", counts.files_age);
      deps.metrics?.incMorgianaSpoolPruned("size", counts.files_size);
    },
    onError: (e) => {
      process.stderr.write(
        `[maintenance] morgiana spool sweep failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    },
  });
}
