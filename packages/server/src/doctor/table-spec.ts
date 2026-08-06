// Which experiential tables `derived.liveness` samples, and what would write each one.
//
// Separated from the probe that executes it for the same reason `column-spec.ts` was: a scan that
// covers nothing reports success, so the SET has to be assertable independently of the check that
// consumes it. The check cannot supply its own floor — it is handed whatever the spec produced.
//
// THE `writer` VALUE IS THE WHOLE CHECK, and both directions of getting it wrong are real:
// permissive hides a defect, strict warns about correct behaviour, and a check that warns about
// correct behaviour gets muted. `derived.liveness` produced eleven warnings on a healthy install
// before it was reclassified once already.
//
// It was wrong again, in the strict direction, on three entries — found by a cross-vendor review
// on 2026-08-06 that read the scheduler rather than the probe:
//
//   preference_profile / preference_deltas  reported `enabled` on every experiential deployment.
//     Their only producer is `extractPreferences`, reachable solely from the manual
//     `obsidian-tc reflect` CLI. The scheduled experiential pass is `evaluateEpisodes`, a
//     DIFFERENT function that never touches these tables. Nothing schedules extraction at all.
//
//   gap_reports  reported `enabled` from the store being open, while THE-719 registers the sweep
//     only when `experiential.gapSweep.enabled` is true — and that DEFAULTS TO FALSE, because each
//     swept query costs an embedding call plus a search. "The store is open" and "the producer is
//     scheduled" are different claims and this conflated them.
//
//   goals  was absent from the spec entirely. The one table in this store with no behavioural
//     consumer was also the one table the liveness surface never mentioned.
import type { DerivedTableState } from "./checks";

export interface TableLivenessSpec {
  table: string;
  writer: DerivedTableState["writer"];
  /** What would write it, or why nothing does. Shown verbatim in the check's remediation. */
  lever: string;
}

export interface TableSpecConfig {
  /** True when any experiential gate is on — the same three the server uses. */
  experiential: boolean;
  /** True when the coverage-gap sweep is SCHEDULED (`experiential.gapSweep.enabled`), NOT merely
   *  when the experiential store is open. Mirrors scheduler-wiring's own registration predicate;
   *  reading `experiential` here instead is precisely what produced the wrong answer. */
  gapSweepScheduled: boolean;
}

export function experientialTableSpec(cfg: TableSpecConfig): TableLivenessSpec[] {
  const on = cfg.experiential;
  const off = (w: DerivedTableState["writer"]): DerivedTableState["writer"] =>
    on ? w : "disabled";
  return [
    // ON-DEMAND, not `enabled`: no scheduled caller exists. An empty table here is a deployment
    // that has never run `reflect`, which is the default state, not a fault.
    {
      table: "preference_profile",
      writer: off("on-demand"),
      lever: "running `obsidian-tc reflect` — preference extraction has no scheduled caller",
    },
    {
      table: "preference_deltas",
      writer: off("on-demand"),
      lever: "running `obsidian-tc reflect` — preference extraction has no scheduled caller",
    },
    // Keyed on the SCHEDULER GATE. With the sweep off (the default) the producer genuinely does
    // not exist and `on-demand` is honest; with it on, `enabled` is, and an empty table then IS
    // worth a warning.
    {
      table: "gap_reports",
      writer: on ? (cfg.gapSweepScheduled ? "enabled" : "on-demand") : "disabled",
      lever: cfg.gapSweepScheduled
        ? "the scheduled coverage-gap sweep"
        : "running `obsidian-tc gaps`, or setting experiential.gapSweep.enabled",
    },
    // Stated-only by construction — the migration CHECK-pins `source` to 'stated' precisely so
    // nothing can infer one — so an empty table is awaiting a caller, never a failed producer.
    {
      table: "goals",
      writer: off("on-demand"),
      lever: "a client calling set_goal (stated-only; nothing infers a goal)",
    },
    {
      table: "forget_log",
      writer: off("on-demand"),
      lever: "a client calling the work_forget / forget verb",
    },
    // Writing today — the healthy baseline. Without at least one of these a green run proves only
    // that the scan found nothing, which is the same floor argument column-spec.ts makes.
    { table: "agent_episodes", writer: off("enabled"), lever: "episode capture" },
    { table: "chunk_retrievals", writer: off("enabled"), lever: "retrieval logging" },
    { table: "vault_object_state", writer: off("enabled"), lever: "the activation recompute" },
    { table: "note_quality", writer: off("enabled"), lever: "the note-quality rollup job" },
  ];
}
