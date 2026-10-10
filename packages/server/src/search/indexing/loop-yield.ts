// A reconcile over a big vault is mostly synchronous JS (read, parse, chunk, SQLite writes) chained
// through microtasks, so `await`ing inside the per-note loop never hands control back to libuv:
// a `tools/call` or a SIGTERM that arrives mid-pass is not even delivered until the pass ends (the
// boot reconcile on a 20 000-note vault held the loop for minutes). embed-batches.ts already forces
// a real event-loop turn between embed sub-batches; this does the same between notes, which is the
// only checkpoint when no embedder is serving.

import { compareWalkEntries, type WalkEntry, walkVaultStream } from "../../vault/paths";

/** Notes processed between forced event-loop turns: ~one turn per few ms of work, not per note. */
export const NOTES_PER_LOOP_YIELD = 64;

/**
 * Returns an async checkpoint to call once per note. It forces a `setImmediate` turn every
 * `every` calls, and ONLY when the caller passed an abort `signal` (the boot reconcile): with no
 * signal there is nothing to deliver, and a forced macrotask changed observable timing for every
 * unsignaled caller (see the same gate in embed-batches.ts and index-vault-in-flight.test.ts).
 */
export function createLoopYielder(
  signal: AbortSignal | undefined,
  every: number = NOTES_PER_LOOP_YIELD,
): () => Promise<void> {
  let sinceYield = 0;
  return async () => {
    if (!signal || ++sinceYield < every) return;
    sinceYield = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}

/**
 * walkVault with a checkpoint per entry: the same entries in the same (whole-path) order, but the
 * directory reads and stats are spread over event-loop turns instead of one synchronous block.
 * Reuses walkVaultStream for the traversal and re-sorts with walkVault's own comparator, so the two
 * cannot drift. Callers with no abort signal keep calling walkVault itself.
 */
export async function walkVaultCooperative(
  root: string,
  opts: { sub?: string; extensions?: string[] },
  yieldToLoop: () => Promise<void>,
): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  for await (const e of walkVaultStream(root, opts)) {
    out.push(e);
    await yieldToLoop();
  }
  return out.sort(compareWalkEntries);
}
