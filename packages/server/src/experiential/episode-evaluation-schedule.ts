// THE-698 — schedules `evaluateEpisodes` (reflect.ts) on the maintenance cadence. Split out of
// reflect.ts (THE-726 review round 1): the derive-step wiring this file gained pushed reflect.ts
// past biome's 700-line ceiling, and this is a clean SCHEDULING boundary, not an arbitrary split —
// reflect.ts stays the deterministic evaluator; this file is the periodic caller, the same relation
// gap-sweep.ts and citation-index.ts have to their own passes. Imports evaluateEpisodes/EvaluateStats
// FROM reflect.ts, never the other way — see DerivedVerdictSummary's own comment for why the
// derive-verdict.ts closure crosses this boundary as a structural type rather than a direct import.

import type { Database } from "../db/types";
import type { Scheduler } from "../scheduler/scheduler";
import { type EvaluateStats, evaluateEpisodes } from "./reflect";

/** THE-726: structural mirror of derive-verdict.ts's `DeriveClosedWindowsOutcome`, declared here
 *  rather than imported: derive-verdict.ts imports `SEARCH_FAMILY_TOOLS` from reflect.ts, and this
 *  file imports `evaluateEpisodes` from reflect.ts too, so importing derive-verdict.ts here as well
 *  would put reflect.ts's own consumers one hop from a cycle for no real benefit. TypeScript's
 *  structural typing means the real `DeriveClosedWindowsOutcome` object satisfies this shape with
 *  no shared declaration — the wiring layer (runtime/plane-wiring.ts) is the one place that
 *  imports BOTH modules and connects them. THE-726 fix round 2: kept in sync by hand is no longer
 *  just a promise. `episode-evaluation-schedule.test.ts` carries a compile-time bidirectional
 *  assignability assertion between this type and `DeriveClosedWindowsOutcome`, so a field added to
 *  one and not the other fails typecheck instead of silently drifting. */
export interface DerivedVerdictSummary {
  sessionsSeen: number;
  stamped: { minus: number; zero: number; plus: number; drained: number };
  skipped: number;
}

/** THE-698: deps for the periodic serve-path episode evaluation (registerEpisodeEvaluation).
 *  Mirrors ActivationRecomputeDeps — same shape, same optional clock, same onError contract. */
export interface EpisodeEvaluationDeps {
  edb: Database;
  intervalMs: number;
  now?: () => number;
  // THE-701 removed `judge` and `maxJudged`. This pass is now purely deterministic, so it acquires
  // no network dependency at all — which was already the stated goal of never defaulting the judge
  // to a lazy gateway lookup, now true by construction rather than by discipline.
  onEvaluate?: (stats: EvaluateStats) => void;
  onError?: (e: unknown) => void;
  /** THE-726: `experiential.derivedVerdictHold`, forwarded to `evaluateEpisodes`. */
  derivedVerdictHold?: boolean;
  /** THE-726: run the derived-verdict pass (derive-verdict.ts's `deriveClosedWindows`)
   *  IMMEDIATELY BEFORE this tick's `evaluateEpisodes`, so a freshly-derived -1 is held in the SAME
   *  pass rather than waiting for the next tick. Injected as a closure, not imported directly (see
   *  `DerivedVerdictSummary`'s own comment) — the wiring layer (runtime/plane-wiring.ts) builds the
   *  closure and decides whether to supply it at all; absent means this step no-ops (see `run`
   *  below). */
  deriveClosedWindows?: () => Promise<DerivedVerdictSummary>;
  /** THE-726 review round 1: the derive step's own counts, for telemetry — the 14-day pre-
   *  registered review reads `sessionsSeen`/`stamped`/`skipped` and this is the one place they
   *  surface out of the scheduled pass. Not called on a derive failure (see `run`'s try/catch —
   *  a failed pass has no counts to report, only an error, which goes to `onError`). */
  onDerive?: (result: DerivedVerdictSummary) => void;
}

/**
 * THE-698 — run the evaluator pass on the maintenance cadence. Registered beside
 * activation-recompute on the same `config.maintenance.intervalMinutes` cadence and behind the
 * same `experientialOpen` gate; no gateway dependency (like note-quality-enqueue), and since
 * THE-701 removed the judge, the deterministic layer is the only thing this pass can do.
 *
 * Every safety invariant lives in evaluateEpisodes and is unchanged by scheduling it: born-
 * 'ineligible' rows are untouchable by the WHERE, contradictory ok/error clusters are held, and a
 * known-bad outcome (-1) is held. Scheduling must never become a way to launder a row the
 * pre-ingest poison scanner already refused, so that is pinned by test. See
 * docs/design/experiential-reflection.md for the measurement that motivated wiring this up.
 */
export function registerEpisodeEvaluation(scheduler: Scheduler, deps: EpisodeEvaluationDeps): void {
  scheduler.register({
    name: "episode-evaluation",
    intervalMs: deps.intervalMs,
    run: async () => {
      // THE-726 review round 1: derive first, in the SAME tick — a derived -1 must be visible to
      // this pass's own read of task_result/verdict_source when derivedVerdictHold is on. Wrapped
      // in its OWN try/catch: the derive step is an ADDITION in front of the evaluator that has
      // been promoting/holding correctly since THE-698, and a throw here (a locked cache.db, a
      // schema surprise) must never take that working pass down with it or trip the scheduler's
      // backoff for a job that would otherwise have succeeded.
      if (deps.deriveClosedWindows) {
        try {
          const derived = await deps.deriveClosedWindows();
          deps.onDerive?.(derived);
        } catch (e) {
          deps.onError?.(e);
        }
      }
      const stats = await evaluateEpisodes(deps.edb, {
        nowMs: (deps.now ?? Date.now)(),
        derivedVerdictHold: deps.derivedVerdictHold,
      });
      deps.onEvaluate?.(stats);
    },
    onError: (e) => deps.onError?.(e),
  });
}
