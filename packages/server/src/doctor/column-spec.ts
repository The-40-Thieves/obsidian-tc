// Which columns derived.column-liveness samples, and what would write each one (THE-720).
//
// Separated from the probe that executes it so the SET can be asserted. A scan that covers nothing
// reports success, so the spec carries an explicit non-empty floor in doctor-column-spec.test.ts —
// the check itself cannot supply that floor, because it is handed whatever the spec produced.
import type { DerivedColumnState } from "./column-liveness";

export interface ColumnLivenessSpec {
  table: string;
  column: string;
  writer: DerivedColumnState["writer"];
  /** What would write it, or why nothing does. Shown verbatim in the check's remediation. */
  lever: string;
}

/**
 * The experiential store's signal-bearing columns.
 *
 * Only experiential.db for now: every column a ticket currently depends on lives here, and a spec
 * that lists columns nobody consumes is noise a reader learns to skip.
 *
 * The `writer` value on each entry is the whole check. Getting it wrong in the permissive direction
 * hides a defect; getting it wrong in the strict direction produces warnings on a correct
 * deployment, and a check that warns about correct behaviour gets muted — derived.liveness
 * produced eleven such warnings on a healthy install before it was reclassified.
 */
export function experientialColumnSpec(cfg: { experiential: boolean }): ColumnLivenessSpec[] {
  const on = cfg.experiential;
  return [
    // THE-718. The emitter decision is "the acting agent stamps it after acting on a result", which
    // is a CLIENT action — so an unstamped column is awaiting its first use, not a fault, and this
    // reports without warning. That visibility is the entire deliverable: before this, 0 stamps
    // across 97 retrieval events was indistinguishable from a healthy table.
    //
    // Deliberately NOT a ratio threshold ("N retrievals and still 0 stamps"). A threshold needs
    // evidence to calibrate and this repo gates behaviour on measurement, not on a plausible
    // number. Making the count visible is the prerequisite for choosing one later.
    {
      table: "chunk_retrievals",
      column: "outcome",
      writer: on ? "on-demand" : "disabled",
      lever: "an agent calling record_retrieval_feedback after acting on a result (THE-718)",
    },
    {
      table: "chunk_retrievals",
      column: "feedback",
      writer: on ? "on-demand" : "disabled",
      lever: "an agent calling record_retrieval_feedback after acting on a result (THE-718)",
    },
    // Stamped only by inferCitations, whose sole wired call site is the CLI and which needs a
    // transcript the server never sees (THE-717, blocked on THE-675). On-demand rather than
    // enabled: nothing schedules it, so "never ran" is the current design, not a malfunction.
    {
      table: "chunk_retrievals",
      column: "cited_in_response",
      writer: on ? "on-demand" : "disabled",
      lever: "running `obsidian-tc citation-infer` against a session transcript (THE-717)",
    },
    {
      table: "chunk_retrievals",
      column: "citation_state",
      writer: on ? "on-demand" : "disabled",
      lever: "running `obsidian-tc citation-infer` against a session transcript (THE-717)",
    },
    // "none", not "disabled", and verified rather than assumed: episodes.ts's INSERT names 20
    // columns and neither of these is among them; the only UPDATEs set blocked/eligibility, and
    // forget.ts NULLs summary rather than filling it. No configuration turns these on, so
    // reporting them as switched-off would imply a switch exists. Both stay findings even when the
    // experiential store is disabled — a column with no producer is structurally unwritten.
    {
      table: "agent_episodes",
      column: "outcome",
      writer: "none",
      lever: "no producer exists — the THE-230 parity axis was never given a writer",
    },
    {
      table: "agent_episodes",
      column: "summary",
      writer: "none",
      lever: "no producer exists — the THE-222 consolidation pass is unwired (blocks THE-642)",
    },
    // The healthy controls, and they are not filler. Without a column that IS reliably written, a
    // green run proves only that the scan found nothing. These are what make a passing result
    // evidence rather than an absence of evidence — the same reason derived.liveness deliberately
    // lists tables that are writing today.
    {
      table: "agent_episodes",
      column: "status",
      writer: on ? "enabled" : "disabled",
      lever: "episode capture at dispatch",
    },
    {
      table: "chunk_retrievals",
      column: "rerank_score",
      writer: on ? "enabled" : "disabled",
      lever: "retrieval logging writing each hit's score",
    },
  ];
}
