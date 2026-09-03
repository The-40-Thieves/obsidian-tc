// THE-717 step 4 — driving a transcript index through the citation pass.
//
// Extracted so the CLI (`citation-infer --transcript-index`) and the DURABLE JOB run byte-identical
// logic. They were briefly two copies, and two copies of "which retrievals get stamped, and which
// are refused" is exactly the kind of divergence that produces a citation nobody can account for:
// the CLI's answer and the scheduler's answer would drift, and the store records only the result.
//
// The pure half — parsing the index and planning passes — stays in transcript-source.ts. This file
// is the I/O and the loop.
import { readFileSync } from "node:fs";
import type { Database } from "../db/types";
import { type InferCitationsOptions, inferCitations } from "./citation";
import { closeCitationRun, openCitationRun } from "./citation-runs";
import { parseTranscriptIndex, planCitationPasses } from "./transcript-source";

/** The knobs a caller supplies; scope and transcript come from the index, never from the caller. */
export type CitationPassOptions = Pick<
  InferCitationsOptions,
  | "embed"
  | "judge"
  | "maxJudged"
  | "judgeConcurrency"
  | "minJudgedForKill"
  | "allowUncertain"
  | "log"
  | "excludeFilter"
>;

/**
 * A TYPE ALIAS, not an interface, and that is load-bearing. The plane's `JobResult.detail` is
 * `Record<string, unknown>`; a TS interface has no implicit index signature and is therefore not
 * assignable to it, while a type alias is. Declaring this as an interface compiles fine here and
 * fails only at the job-wiring call site, which is a confusing place to meet the error.
 */
export type CitationIndexRunResult = {
  entries: number;
  malformed: number[];
  passes: number;
  skipped: Array<{ reason: string; surface_type: string; retrieved_at: number; query: string }>;
  scoped: number;
  /** Rows stamped cited_in_response = 1. NOT the same as rows written — see citation-runs.ts. */
  cited: number;
  /** Passes whose kill switch tripped. Counted, because a run that aborts every pass and a run
   *  with nothing to do both report cited=0. */
  abortedPasses: number;
};

/**
 * Run one citation pass per entry in a transcript index.
 *
 * ONE PASS PER RETRIEVAL, never one over the union — `inferCitations` scores every chunk in scope
 * against a single transcript, which is only correct when the scope IS one retrieval. The plan
 * enforces that; this just executes it.
 *
 * Returns counts rather than printing. The CLI formats them for a human, the job records them
 * through the plane's own reporting, and neither has to parse the other's prose.
 *
 * A missing index file is NOT swallowed. `readFileSync` throws, the job dead-letters, and the
 * failure is visible — which is the point: a scheduled pass whose input silently vanished would
 * otherwise report success with zero work forever.
 */
export async function runCitationIndexPasses(
  indexPath: string,
  edb: Database,
  cacheDb: Database,
  opts: CitationPassOptions,
): Promise<CitationIndexRunResult> {
  const { entries, malformed } = parseTranscriptIndex(readFileSync(indexPath, "utf8"));
  const plan = planCitationPasses(entries);

  // THE-744: an invocation that plans ZERO passes writes its own row. `openCitationRun` is called
  // once per pass, so without this a successful run over an empty index left `citation_runs`
  // byte-identical to a deployment where the feature was never enabled — and `SELECT * FROM
  // citation_runs` is the documented way to answer "did the pass ever fire?". It answered "no".
  //
  // Scoped `index`, never `window`/`session`, so `passesCoveringWindow` cannot return it: an
  // invocation that did no work must not read as coverage of any retrieval. `entries` is recorded
  // rather than assumed zero, because "the index was empty" and "entries existed but every one was
  // skipped or malformed" both land here and are different operational stories.
  //
  // Deliberately NOT an error and NOT a non-zero exit — a pass with no work is a healthy pass, and
  // THE-645 item 3 settled that this signal belongs in the record, not the exit status.
  if (plan.passes.length === 0) {
    const now = Date.now();
    const runId = openCitationRun(edb, {
      scope: "index",
      judgePresent: opts.judge != null,
      startedAt: now,
    });
    closeCitationRun(edb, runId, {
      entries: entries.length,
      scoped: 0,
      stage1Pass: 0,
      judged: 0,
      parseFailures: 0,
      judgeErrors: 0,
      stamped: 0,
      aborted: false,
      finishedAt: Date.now(),
    });
  }

  let scoped = 0;
  let cited = 0;
  let abortedPasses = 0;
  for (const p of plan.passes) {
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: p.entry.transcript,
      windowMs: p.window,
      ...opts,
    });
    scoped += stats.scoped;
    cited += stats.cited;
    if (stats.aborted) abortedPasses += 1;
  }

  return {
    entries: entries.length,
    malformed,
    passes: plan.passes.length,
    skipped: plan.skipped.map((s) => ({
      reason: s.reason,
      surface_type: s.entry.surface_type,
      retrieved_at: s.entry.retrieved_at,
      query: s.entry.query,
    })),
    scoped,
    cited,
    abortedPasses,
  };
}
