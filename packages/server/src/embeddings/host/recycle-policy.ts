// GH #1433 rec 4, step 3: when the child-process embedder is recycled. A recycle drains the child, so
// its memory returns to the OS and the next embed spawns a fresh one. Two burst ends call onBurstEnd:
// a finished index pass (full-reconcile, always recycles) and the index-on-write queue going idle
// (write-drain, recycles only while parent + child RSS is over the memory budget). Only child-process
// hosts are recycled, and each host at most once per RECYCLE_DEBOUNCE_MS.
import { allLiveHosts } from "./registry";
import type { EmbedderHost } from "./types";

export type BurstEnd = "full-reconcile" | "write-drain";

/** At most one recycle per host inside this window. */
export const RECYCLE_DEBOUNCE_MS = 30_000;

const MIB = 1024 * 1024;

const lastRecycleAt = new WeakMap<EmbedderHost, number>();
const totals = { reconcile: 0, budget: 0 };

/** Recycles performed by the policy, by reason, for the restart counter (metrics/embedder-host-counters.ts). */
export function embedderRecycleTotals(): Readonly<typeof totals> {
  return { ...totals };
}

/** Called at each burst end. Never rejects: a failed stats or recycle is logged and skipped, so the
 *  index path that fired it is not affected. */
export async function onBurstEnd(kind: BurstEnd, budgetMb?: number): Promise<void> {
  try {
    for (const host of allLiveHosts()) {
      if (host.kind !== "child-process") continue;
      const stats = await host.stats();
      // A request queued or in flight is not interrupted: the next burst end with an empty queue acts.
      if ((stats.queued ?? 0) > 0) continue;
      const overBudget =
        budgetMb !== undefined &&
        process.memoryUsage().rss + (stats.rssBytes ?? 0) > budgetMb * MIB;
      if (kind === "write-drain" && !overBudget) continue;
      const now = Date.now();
      const last = lastRecycleAt.get(host);
      if (last !== undefined && now - last < RECYCLE_DEBOUNCE_MS) continue;
      lastRecycleAt.set(host, now);
      const reason = kind === "full-reconcile" ? "reconcile" : "budget";
      totals[reason] += 1;
      await host.recycle(reason);
    }
  } catch (error) {
    console.error(`embedder host: recycle at burst end failed: ${String(error)}`);
  }
}
