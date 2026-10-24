// Directed-cycle enumeration for find_link_cycles and vault_health_score (Refs #1332).
import type { ScanSteps } from "../../util/scan-steps";

/** Work the scan may spend before it stops counting: one unit per node entered, per edge examined,
 *  and per link of each cycle it closes. A typical 20 000-note vault (~60 000 links) needs a small
 *  fraction of it, so a truncated answer means a dense or deep-cycled graph. Measured on Cave on
 *  synthetic 20 000-note graphs with long cycles, the cap is reached in 35-90 ms (about 25-45 ns a
 *  unit), so a dense vault cannot hold the event loop for long even between yields. */
export const CYCLE_SCAN_WORK_CAP = 2_000_000;

export interface CycleScanOptions {
  /** Cycles kept in the returned page. */
  limit: number;
  /** Cycles with fewer links than this are not counted (2 is a note and the note it links back to). */
  minLength: number;
  /** Cycles with more links than this are not counted; they are tallied in `skippedLonger`. */
  maxLength: number;
  /** Work the scan may spend before it stops counting (see CYCLE_SCAN_WORK_CAP). */
  maxWork: number;
  /** Keep counting after the page is full (for `total`). False stops the scan at a full page. */
  countPastLimit: boolean;
}

export interface CycleScan {
  /** The first `limit` cycles found, each an ordered path whose last node repeats the first. */
  cycles: string[][];
  /** Cycles counted within [minLength, maxLength]. A lower bound when `truncated`. */
  total: number;
  skippedShorter: number;
  skippedLonger: number;
  /** True when the work cap stopped the scan before every cycle was counted. */
  truncated: boolean;
}

/** DFS back-edges over one global DFS, so every cycle is found once and rotated to start at the
 *  node the DFS entered first (two back-edges never close the same edge set, so no two reports
 *  share a rotation). Iterative (an explicit stack of neighbour iterators) with a step per node and
 *  per edge, so a drain can hand the event loop back, and a 20 000-deep chain cannot overflow. */
export function* findLinkCyclesSteps(
  out: Map<string, Set<string>>,
  opts: CycleScanOptions,
): ScanSteps<CycleScan> {
  const { limit, minLength, maxLength, maxWork, countPastLimit } = opts;
  const state = new Map<string, number>(); // 0 unseen, 1 on-stack, 2 done
  const stack: string[] = [];
  const nexts: Iterator<string>[] = [];
  const cycles: string[][] = [];
  let total = 0;
  let skippedShorter = 0;
  let skippedLonger = 0;
  let work = 0;
  let truncated = false;
  const enter = (u: string): void => {
    state.set(u, 1);
    stack.push(u);
    nexts.push((out.get(u) ?? new Set<string>()).values());
    work++;
  };
  outer: for (const n of out.keys()) {
    if ((state.get(n) ?? 0) !== 0) continue;
    if (work >= maxWork) {
      truncated = true;
      break;
    }
    enter(n);
    yield;
    while (stack.length > 0) {
      if (work >= maxWork) {
        truncated = true;
        break outer;
      }
      const nx = (nexts[nexts.length - 1] as Iterator<string>).next();
      work++;
      if (nx.done) {
        nexts.pop();
        state.set(stack.pop() as string, 2);
        yield;
        continue;
      }
      const w = nx.value;
      const s = state.get(w) ?? 0;
      if (s === 1) {
        const i = stack.lastIndexOf(w);
        if (i < 0) continue;
        const links = stack.length - i;
        work += links;
        if (links > maxLength) skippedLonger++;
        else if (links < minLength) skippedShorter++;
        else {
          total++;
          if (cycles.length < limit) cycles.push([...stack.slice(i), w]);
          if (!countPastLimit && cycles.length >= limit) break outer;
        }
      } else if (s === 0) {
        enter(w);
        yield;
      }
    }
    yield;
  }
  return { cycles, total, skippedShorter, skippedLonger, truncated };
}

/** The graph restricted to notes under `folder`: members outside it, and edges leaving it, are gone. */
export function restrictToFolder(
  out: Map<string, Set<string>>,
  folder: string,
): Map<string, Set<string>> {
  const prefix = `${folder}/`;
  const inside = (p: string): boolean => p.startsWith(prefix);
  const scoped = new Map<string, Set<string>>();
  for (const [p, targets] of out) {
    if (!inside(p)) continue;
    scoped.set(p, new Set([...targets].filter(inside)));
  }
  return scoped;
}
