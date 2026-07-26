// THE-465: staged retrieval pipeline instrumentation. Purely additive over the THE-459
// count-only `onStage` callback (still fired unchanged, in the same places, with the same
// stage names — nothing here removes or reorders those calls): `onStageMetric` is a NEW,
// independently-optional callback that receives one typed record per named pipeline stage
// with candidatesIn/candidatesOut/durationMs. Default undefined on both callbacks -> zero
// overhead beyond a monotonic-clock read (`performance.now()`) and no behavior change.
import { performance } from "node:perf_hooks";

/** The named stages of the graph-search pipeline, in the order they run. Kept as a union
 *  (not a free string) so a typo in a stage name is a compile error, not a silent no-op. */
export type StageName =
  | "classify"
  | "seedGeneration"
  | "graphExpansion"
  | "candidateAssembly"
  | "scoreFusion"
  | "diversity"
  | "gatedRerank"
  | "projection";

/** One typed record per stage: how many candidates entered, how many left, and how long the
 *  stage took. "Candidates" for the pre-candidate-set stages (classify/seedGeneration) counts
 *  the seed pool the stage produced or consumed — see each call site's comment for the exact
 *  definition used, since not every stage has a literal Candidate[] on both sides. */
export interface StageMetric {
  stage: StageName;
  candidatesIn: number;
  candidatesOut: number;
  durationMs: number;
  /** THE-585 (#12): content bytes materialized before/after this stage's boundary
   *  (`Buffer.byteLength`, not character count). Optional and populated ONLY at the stages
   *  where hydrated content actually changes hands — candidateAssembly (where the merged
   *  candidate set's content is first counted) and diversity/gatedRerank (where the top-K cut
   *  discards most of what was hydrated). Every other stage omits both fields. */
  bytesIn?: number;
  bytesOut?: number;
}

export type OnStageMetric = (metric: StageMetric) => void;

/** Runs `fn`, timing it and reporting a StageMetric to `onStageMetric` (if provided). Never
 *  alters `fn`'s return value or throws behavior — a stage that throws still propagates the
 *  error after nothing is reported (no partial/misleading metric on failure).
 *
 *  `bytes`, like `candidatesIn`/`countOut`, is optional: only the call sites that materialize or
 *  discard hydrated content pass it (THE-585 #12). `bytes.in` is a plain number (the caller
 *  already has it before `fn` runs); `bytes.out` is derived from the result, mirroring
 *  `countOut`. */
export async function runStage<T>(
  stage: StageName,
  candidatesIn: number,
  fn: () => T | Promise<T>,
  countOut: (result: T) => number,
  onStageMetric: OnStageMetric | undefined,
  bytes?: { in: number; out: (result: T) => number },
): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  if (onStageMetric) {
    onStageMetric({
      stage,
      candidatesIn,
      candidatesOut: countOut(result),
      durationMs: performance.now() - t0,
      ...(bytes ? { bytesIn: bytes.in, bytesOut: bytes.out(result) } : {}),
    });
  }
  return result;
}
