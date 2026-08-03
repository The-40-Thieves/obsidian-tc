// entrypoints.liveness — derived.liveness, applied to VERBS instead of TABLES.
//
// Split out of checks.ts rather than appended to it: that file sits at the 700-line ceiling the
// structural-refactor program set, and this check has its own probe shape and its own module-local
// helper. Pure classification over an injected probe, so it is unit-testable with no live server,
// DB, or network — the same contract every other check in this directory holds to.

import type { Check, CheckStatus } from "./types";

/** One scheduled pass, as the scheduler's own durable state records it (`job_schedule`). */
export interface ScheduledPassState {
  name: string;
  /** null when the pass is registered but its interval has not elapsed since boot. */
  lastRunAt: number | null;
  /** null when it has run and never once completed successfully. */
  lastSuccessAt: number | null;
  consecutiveFailures: number;
}

/**
 * The tool-invocation census, from the episode log.
 *
 * A LOWER BOUND by construction and it must always be reported as one. Episode capture is
 * per-caller, `captureEpisodes` can be off, and the eval harness and CLI bypass the MCP surface
 * entirely — so a small number is as likely to mean "capture is narrow" as "the surface is dead".
 */
export interface ToolCensus {
  distinctTools: number;
  episodes: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface EntryPointsProbe {
  passes: ScheduledPassState[];
  /** null means NOT MEASURED — never coerce it to 0. A measured zero and an absent measurement are
   *  different facts, and encoding one as the other is the shape that makes a failure look like a
   *  valid result downstream. */
  tools: ToolCensus | null;
  /** THE-715: `job_schedule.name` is a TEXT PRIMARY KEY, which SQLite does not enforce as NOT NULL,
   *  so every UPSERT with a null name inserted instead of updating. Surfaced, not warned on — it is
   *  already ticketed and the named rows update correctly. */
  orphanScheduleRows: number;
}

export interface EntryPointsView {
  probe?: () => EntryPointsProbe;
}

/**
 * entrypoints.liveness — derived.liveness, applied to VERBS instead of TABLES.
 *
 * `derived.liveness` answers "is this table being written". It cannot answer "is this pass
 * registered at all", nor "has anything ever called this tool", and those are two distinct shapes
 * the table check structurally cannot see:
 *
 *   THE-714  workspace_sessions empty across 2,352 tool calls — no client ever called start_session
 *   THE-717  inferCitations is CLI-only; every citation column NULL on 97/97 rows
 *   THE-719  the gaps calibration pass is CLI-only; gap_reports never written
 *
 * In all three the TABLE check fires correctly and names a lever that is already switched on, which
 * sends the reader looking for a config problem that does not exist. The missing fact is about the
 * entry point, not the table.
 *
 * CLASSIFICATION IS THE POINT, exactly as in derived.liveness. Only two things warn:
 *
 *   ran, never succeeded  -> WARNING  (registered and losing every time)
 *   failing now           -> WARNING  (succeeded before, consecutive failures since)
 *   registered, not ticked-> ok       (interval has not elapsed; warning here fires on every
 *                                      fresh install for as long as the longest interval)
 *   tool census           -> ok, ALWAYS (see ToolCensus — an unexercised verb is not a fault)
 *
 * A warning, never a fail: a dead entry point breaks no request in flight. What it breaks is the
 * assumption that a registered pass is a running one.
 */
export function entryPointsCheck(view: EntryPointsView): Check {
  return {
    id: "entrypoints.liveness",
    category: "runtime",
    run: () => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "entry points (not probed): run `doctor --probe` to read the schedule",
          details: { entrypoints: "not probed" },
        };
      }
      const { passes, tools, orphanScheduleRows } = view.probe();
      if (passes.length === 0 && tools === null) {
        return {
          status: "ok" as CheckStatus,
          summary: "entry points: no scheduler state to inspect",
          details: { entrypoints: "no scheduler state" },
        };
      }

      // Mutually exclusive, in precedence order — a pass in two buckets would be double-counted in
      // the summary and read as two findings.
      const failing = passes.filter((p) => p.consecutiveFailures > 0);
      const neverSucceeded = passes.filter(
        (p) => p.consecutiveFailures === 0 && p.lastSuccessAt === null && p.lastRunAt !== null,
      );
      const notYetRun = passes.filter(
        (p) => p.consecutiveFailures === 0 && p.lastRunAt === null && p.lastSuccessAt === null,
      );
      const healthy = passes.filter((p) => p.consecutiveFailures === 0 && p.lastSuccessAt !== null);

      const details: Record<string, string | string[]> = {
        scheduled: passes.map((p) => p.name),
        toolsInvoked: describeCensus(tools),
      };
      if (notYetRun.length > 0) details.notYetRun = notYetRun.map((p) => p.name);
      if (neverSucceeded.length > 0) details.neverSucceeded = neverSucceeded.map((p) => p.name);
      if (failing.length > 0) {
        details.failing = failing.map((p) => `${p.name} (${p.consecutiveFailures} consecutive)`);
      }
      if (orphanScheduleRows > 0) {
        details.scheduleOrphans = `${orphanScheduleRows} unnamed job_schedule row(s) — THE-715, does not affect the named rows above`;
      }

      if (neverSucceeded.length === 0 && failing.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `entry points: ${healthy.length} scheduled pass(es) healthy, ${notYetRun.length} not yet run`,
          details,
        };
      }
      const issues = [
        ...neverSucceeded.map(
          (p) =>
            `${p.name}: registered and has run, but has never succeeded — its output is empty for that reason, not for want of configuration`,
        ),
        ...failing.map(
          (p) => `${p.name}: ${p.consecutiveFailures} consecutive failures since its last success`,
        ),
      ];
      return {
        status: "warning" as CheckStatus,
        summary: `entry points: ${neverSucceeded.length} never succeeded, ${failing.length} failing (${healthy.length} healthy)`,
        details,
        issues,
        remediation:
          "A pass under `neverSucceeded` is registered, ticking, and losing every time — read its dead-letter or error sink rather than its config. Cross-reference `derived.liveness`: a table it reports as `silent` whose writer appears here has an execution failure, not a configuration one, and those two need opposite fixes. `toolsInvoked` is a lower bound and is never a finding on its own.",
      };
    },
  };
}

/** Render the census so "not measured" can never be mistaken for a measured zero. */
function describeCensus(tools: ToolCensus | null): string {
  if (tools === null) return "not measured (no episode capture in this store)";
  const window =
    tools.firstAt !== null && tools.lastAt !== null
      ? `, ${new Date(tools.firstAt).toISOString().slice(0, 10)} to ${new Date(tools.lastAt).toISOString().slice(0, 10)}`
      : "";
  return `at least ${tools.distinctTools} distinct tool(s) across ${tools.episodes} episode(s)${window} — a LOWER BOUND, capture is per-caller`;
}
