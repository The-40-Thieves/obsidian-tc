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
import type { Database } from "../db/types";
import type { MorgianaEmitter } from "../morgiana/emitter";
import type { Scheduler } from "../scheduler/scheduler";
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
  };
  /** config.observability.retention */
  retention: { eventLogDays: number; tracesDays: number };
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
  defaultTraceFolder: string;
  /** THE-610 arm 2: the experiential.db handle, when the membrane is open. Absent -> both
   *  experiential arms skip and report 0, which is correct when there is nothing to sweep. */
  edb?: Database;
  morgiana: MorgianaEmitter;
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
  registerMaintenanceSweep(scheduler, {
    db: deps.db,
    intervalMs: deps.maintenance.intervalMinutes * 60_000,
    eventLogDays: deps.retention.eventLogDays,
    jobsCompleteDays: deps.maintenance.jobsCompleteRetentionDays,
    jobsFailedDays: deps.maintenance.jobsFailedRetentionDays,
    tracesDays: deps.retention.tracesDays,
    // THE-737: sweep BOTH generations -- the cacheDir directory new sessions write to, and
    // the legacy per-vault dirs that still hold pre-migration traces.
    traceDirs: [
      resolveCacheTraceDir(deps.cacheDir),
      ...resolveTraceDirs(deps.vaults, deps.defaultTraceFolder),
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
