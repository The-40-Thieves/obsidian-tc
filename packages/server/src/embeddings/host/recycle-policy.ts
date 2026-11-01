// GH #1433 rec 4, step 3: when the child-process embedder is recycled. A recycle drains the child, so
// its memory returns to the OS and the next embed spawns a fresh one. Two burst ends call onBurstEnd:
// a finished index pass (full-reconcile, recycles when the pass embedded chunks) and the index-on-write
// queue going idle (write-drain). Either burst end also recycles while the budget rule holds: the
// parent alone is under embeddings.memoryBudgetMb and parent + child RSS is over it. A recycle cannot
// shrink a parent that is over the budget by itself, so that case never recycles. Only child-process
// hosts with a running child are recycled, each host at most once per RECYCLE_DEBOUNCE_MS, and each
// recycle logs one stderr line.
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

export interface BurstEndOpts {
  /** memoryBudgetMb: absent means no budget rule. */
  budgetMb?: number;
  /** Chunks the finished pass embedded. Zero means nothing changed, so a full reconcile keeps the
   *  loaded model. */
  embeddedChunks?: number;
}

/** Called at each burst end. Never rejects: a failed stats or recycle is logged and skipped, so the
 *  index path that fired it is not affected. */
export async function onBurstEnd(kind: BurstEnd, opts: BurstEndOpts = {}): Promise<void> {
  try {
    for (const host of allLiveHosts()) {
      if (host.kind !== "child-process") continue;
      const stats = await host.stats();
      // No child running: nothing to drain, and no child RSS to count against the budget.
      if (stats.pid === undefined) continue;
      // A request queued or in flight is not interrupted: the next burst end with an empty queue acts.
      if ((stats.queued ?? 0) > 0) continue;
      const parentRss = process.memoryUsage().rss;
      const childRss = stats.rssBytes ?? 0;
      const budgetBytes = opts.budgetMb === undefined ? undefined : opts.budgetMb * MIB;
      const overBudget =
        budgetBytes !== undefined &&
        stats.rssBytes !== undefined &&
        parentRss < budgetBytes &&
        parentRss + childRss > budgetBytes;
      const worthRecycling =
        kind === "full-reconcile" ? (opts.embeddedChunks ?? 0) > 0 || overBudget : overBudget;
      if (!worthRecycling) continue;
      const now = Date.now();
      const last = lastRecycleAt.get(host);
      if (last !== undefined && now - last < RECYCLE_DEBOUNCE_MS) continue;
      lastRecycleAt.set(host, now);
      const reason = kind === "full-reconcile" ? "reconcile" : "budget";
      totals[reason] += 1;
      console.error(
        `embedder host recycled: reason=${reason} child_rss_mb=${Math.round(childRss / MIB)} ` +
          `total_mb=${Math.round((parentRss + childRss) / MIB)}`,
      );
      await host.recycle(reason);
    }
  } catch (error) {
    console.error(`embedder host: recycle at burst end failed: ${String(error)}`);
  }
}
