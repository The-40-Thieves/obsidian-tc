// Whole-vault scans as step generators. A scan that reads and parses every note is mostly
// synchronous JS, so `await`ing inside its loop never hands control back to libuv: on a 20 000-note
// vault vault_health_score, find_orphans, find_unresolved_links, find_link_cycles, get_backlinks and
// audit_provenance each held the event loop for 6-8 s, and a timer, a second tool call or SIGTERM
// waited behind them. Each scan is written ONCE as a generator that `yield`s after every note (and
// every directory of the walk); the two drivers below run the same body, so the answer cannot
// depend on how it was driven:
//
//   drainSteps      synchronous, for callers that already block (lint_wiki, the scheduled lint)
//   drainYielding   a real `setImmediate` turn whenever a time slice has been used up, and an abort
//                   check on each turn
//
// A worker thread was measured and rejected: the scan needs the ACL, the native note reader and the
// YAML parser, none of which a worker can load from a `bun --compile` binary, which embeds no
// assets. regex-worker.ts can use one only because its source is a self-contained string.
import { checkAborted } from "../mcp/registry/abort";

/** A scan body: yields once per unit of work (a note, a directory), returns the scan's result. */
export type ScanSteps<T> = Generator<void, T, void>;

/** Longest a scan runs before it hands the event loop back. A slice is the worst-case delay a
 *  timer, a concurrent tool call or SIGTERM sees on top of one note's own work. */
const SCAN_SLICE_MS = 5;

/** Run a scan to completion without ever yielding the event loop. */
export function drainSteps<T>(steps: ScanSteps<T>): T {
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
}

/**
 * Run a scan, handing the event loop back whenever `sliceMs` of work has gone by since the last
 * turn. The turn is forced for every caller, with or without a signal: a tool call must not starve
 * its neighbours. `signal` (the transport's per-request AbortSignal) is checked before the first
 * step and after every turn, which is the only place it can have changed, so a cancelled call stops
 * scanning within one slice and throws the modelled `aborted` error.
 */
export async function drainYielding<T>(
  steps: ScanSteps<T>,
  signal: AbortSignal | undefined,
  sliceMs: number = SCAN_SLICE_MS,
): Promise<T> {
  checkAborted(signal);
  let sliceStart = performance.now();
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value;
    if (performance.now() - sliceStart < sliceMs) continue;
    await new Promise<void>((resolve) => setImmediate(resolve));
    checkAborted(signal);
    sliceStart = performance.now();
  }
}
