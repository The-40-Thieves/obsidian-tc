// The child-process embedder's restart counter: how often the burst-end recycle policy drained it, by
// reason. Read at scrape time from the policy's process-wide totals (a Counter collect hook), so no
// call site threads a metrics handle into the policy.
import { Counter, type Registry } from "@prometheus-io/client";
import { embedderRecycleTotals } from "../embeddings/host/recycle-policy";

export function registerEmbedderHostRestarts(registers: Registry[]): void {
  new Counter({
    name: "obsidian_tc_embedder_host_recycles_total",
    help: "Embedder child processes the burst-end recycle policy drained, by reason (reconcile = a finished index pass that embedded chunks, budget = parent + child RSS over embeddings.memoryBudgetMb at a write-queue drain while the parent alone is under it). Cumulative. A crash-restart is not counted here.",
    labelNames: ["reason"],
    registers,
    collect() {
      this.reset();
      const totals = embedderRecycleTotals();
      for (const reason of ["reconcile", "budget"] as const) {
        if (totals[reason] > 0) this.inc({ reason }, totals[reason]);
      }
    },
  });
}
