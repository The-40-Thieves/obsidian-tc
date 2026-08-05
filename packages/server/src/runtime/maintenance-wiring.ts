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
  /** config.sessions — THE-726. Absent, or autoOpen false, leaves the session arm unarmed. */
  sessions?: { autoOpen: boolean; windowSeconds: number };
  /** config.vaults — trace dirs are per-vault and resolved with containment checking (THE-610). */
  vaults: readonly { id: string; path: string; workspace?: { traceFolder: string } }[];
  defaultTraceFolder: string;
  /** THE-610 arm 2: the experiential.db handle, when the membrane is open. Absent -> both
   *  experiential arms skip and report 0, which is correct when there is nothing to sweep. */
  edb?: Database;
  morgiana: MorgianaEmitter;
  /** Vault id the process-wide sweep event is attributed to (run_serve's first vault). */
  eventVaultId: string;
  now?: () => number;
}

/** Total pruned across EVERY arm. Split out so the "a new arm is counted for free" claim is a
 *  callable function rather than a comment — see maintenance-wiring.test.ts. */
export function sweepTotal(counts: SweepCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
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
        }
      : {}),
    // THE-726: only pass the window when autoOpen is on. Passing it unconditionally would arm a
    // sweep arm against sessions that cannot exist, and — worse — would silently start closing
    // `caller IS NULL` rows if any other writer ever produced that shape.
    ...(deps.sessions?.autoOpen === true
      ? { sessionWindowSeconds: deps.sessions.windowSeconds }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    onSweep: (counts) => {
      const total = sweepTotal(counts);
      deps.morgiana.emit(deps.eventVaultId, "tc.maintenance.sweep", {
        count: total,
        rows_dropped: { ...counts },
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
