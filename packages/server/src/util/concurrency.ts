/**
 * Minimal bounded-concurrency runner. THE-448 (multi-query fan-out) needs to run several
 * graphSearch calls in parallel without spawning one Promise per query variant unbounded — and
 * the repo has no existing primitive for this: IndexCoordinator's concurrency knobs (cli.ts,
 * THE-458) serialize per-(vault,path) WRITES so same-path mutations order correctly, a different
 * problem from "run N independent async calls, at most K at once".
 *
 * Pull-based worker pool: `limit` workers each repeatedly claim the next unclaimed index and run
 * `fn` on it, so results are written to their ORIGINAL index regardless of completion order —
 * callers get back an array positionally aligned with `items`, not arrival order.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
