// THE-752 Tier 0 — the deterministic (no-LLM) writer for agent_episodes.summary.
//
// `summary` has had readers and no writer since 20260711_002 (see that migration's header and
// column-spec.ts's "none" entry, which this ticket corrects). Building an LLM reflection layer
// over the agent's own logs is recursive-self-training-shaped and risks the rise-then-collapse
// pattern the 2026 self-training literature documents (self-improvement campaigns that regress,
// recursive summarization that erodes low-frequency tails). This module deliberately ships NONE
// of that: every field below is copied or tallied from columns `episodes.ts` already wrote at
// capture time — never inferred, never generated, never summarized-from-a-summary. That is what
// makes it safe to run unconditionally, at any corpus size, with zero collapse risk: there is no
// model in the loop to collapse.
//
// The Tier 1 LLM reflection layer this ticket explicitly EXCLUDES stays gated behind THE-707 (a
// scorable benchmark does not exist yet) and a corpus threshold neither half of which is met on
// the live store today. Building it is out of scope here — see THE-752's own body.
//
// Idempotency: `buildEpisodeSummary` is a PURE function of its inputs. Re-running the evaluator
// pass over an already-summarized (but still `pending`, i.e. held) row reproduces byte-identical
// JSON as long as the underlying columns and the tool tally it is handed are unchanged — a stable
// regeneration, not a churn source. Once a row is promoted to `eligible` it drops out of the
// evaluator's WHERE entirely, so its summary is written exactly once.

/** The row shape this module needs. A deliberate subset of agent_episodes — every field here is
 *  one `episodes.ts` already writes at capture; nothing is derived from `args_json` (the content
 *  axis, default OFF, and out of scope for Tier 0 — see the file header). */
export interface EpisodeSummarySource {
  tool: string | null;
  caller: string | null;
  status: string;
  /** -1 | 0 | +1 | null — the ground-truth anchor (THE-726's `work_result` verdict). Mandatory
   *  field of every summary per the collapse-literature mitigation: never optional, never
   *  inferred. */
  task_result: number | null;
  /** JSON array string (poison tags today; THE-720's multi-axis tag surface later) or NULL. */
  tags: string | null;
}

/** Tool -> dispatch count within this episode's window (its session, when known). Computed by the
 *  caller from the same table — see `evaluateEpisodes` in reflect.ts — so this module stays a pure
 *  string formatter with no DB dependency of its own. */
export type ToolTally = Readonly<Record<string, number>>;

export type EpisodeVerdict = "pass" | "fail" | "neutral" | "unjudged";

/** THE-565/THE-726 vocabulary, restated as a reader-facing enum: -1 known-bad, 0 recorded-neutral,
 *  +1 known-good, NULL never judged. Matches `partitionPending`'s own reading of the column. */
export function episodeVerdict(taskResult: number | null): EpisodeVerdict {
  if (taskResult === 1) return "pass";
  if (taskResult === -1) return "fail";
  if (taskResult === 0) return "neutral";
  return "unjudged";
}

/** Best-effort parse of the `tags` column. Malformed JSON (should not happen — the only writer is
 *  `JSON.stringify` in episodes.ts) degrades to an empty list rather than throwing; a summary
 *  writer must never fail the evaluator pass it runs inside. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** The provenance-receipt shape stored (as JSON) in `agent_episodes.summary`. Every field is
 *  observed, never generated — see the file header. */
export interface EpisodeSummary {
  intent: string;
  verdict: EpisodeVerdict;
  status: string;
  tool_calls: ToolTally;
  tags: string[];
  generated_by: "deterministic-v1";
}

/** Build the Tier 0 receipt for one episode. Pure and deterministic: same inputs, same output,
 *  every run — that is the idempotency contract `evaluateEpisodes` relies on for held rows that
 *  get re-evaluated on a later pass. */
export function buildEpisodeSummary(
  row: EpisodeSummarySource,
  toolTally: ToolTally,
): EpisodeSummary {
  return {
    intent: `${row.tool ?? "unknown"} by ${row.caller ?? "unknown"}`,
    verdict: episodeVerdict(row.task_result),
    status: row.status,
    tool_calls: toolTally,
    tags: parseTags(row.tags),
    generated_by: "deterministic-v1",
  };
}

/** Serialized form actually written to the column. A separate export from `buildEpisodeSummary`
 *  so a caller that wants the structured object (e.g. a future reader, or a test) is not forced
 *  through a parse round-trip. */
export function serializeEpisodeSummary(row: EpisodeSummarySource, toolTally: ToolTally): string {
  return JSON.stringify(buildEpisodeSummary(row, toolTally));
}
