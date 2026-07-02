// THE-293 — true regex-execution timeout for search_regex. A JavaScript regex cannot be
// interrupted in-process, so the per-line scan runs in a single lazy worker thread and each
// job races the caller's remaining budget; on overrun the worker is terminated (the only way
// to stop a catastrophic exec) and lazily recreated on the next call. The worker source is an
// embedded dependency-free CommonJS string run with { eval: true }, so the bundler never needs
// a separate worker entry file. If the runtime cannot run the eval worker (the readiness
// handshake fails), callers fall back to the inline scan — the prior heuristic-only behavior.
import { Worker } from "node:worker_threads";
import { err } from "@the-40-thieves/obsidian-tc-shared";

export interface RegexJob {
  pattern: string;
  flags: string;
  lines: string[];
  maxPerFile: number;
}

export interface WorkerHit {
  line: number;
  col: number;
  match: string;
}

// Mirrors text.ts's per-line loop exactly: lastIndex reset per line, zero-width-match guard,
// per-file cap. Kept dependency-free CJS — it is evaluated verbatim inside the worker.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (job) => {
  if (job.ping) {
    parentPort.postMessage({ id: job.id, hits: [] });
    return;
  }
  try {
    const re = new RegExp(job.pattern, job.flags);
    const hits = [];
    for (let i = 0; i < job.lines.length && hits.length < job.maxPerFile; i++) {
      const ln = job.lines[i];
      re.lastIndex = 0;
      let m = re.exec(ln);
      while (m !== null && hits.length < job.maxPerFile) {
        hits.push({ line: i + 1, col: m.index + 1, match: m[0] });
        if (m[0] === "") re.lastIndex += 1;
        m = re.exec(ln);
      }
    }
    parentPort.postMessage({ id: job.id, hits });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String(e && e.message ? e.message : e) });
  }
});
`;

interface Pending {
  resolve: (hits: WorkerHit[]) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let seq = 0;
// null = not probed yet; false = this runtime cannot run the eval worker (fall back inline).
let capable: boolean | null = null;
const pending = new Map<number, Pending>();

function failAll(reason: string): void {
  for (const [id, p] of pending) {
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  worker = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  // Never pin the process: the stdio server exits on stdin EOF.
  w.unref();
  w.on("message", (msg: { id: number; hits?: WorkerHit[]; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.hits ?? []);
  });
  w.on("error", () => failAll("regex worker errored"));
  w.on("exit", () => {
    if (worker === w) failAll("regex worker exited");
  });
  worker = w;
  return w;
}

function post(
  job: RegexJob | { ping: true },
  timeoutMs: number,
  pattern: string,
): Promise<WorkerHit[]> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<WorkerHit[]>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(id);
        // terminate is the only way to stop a catastrophic exec; recreate lazily next call.
        // Other queued jobs on the dead worker settle via their own deadlines (bounded).
        const dead = worker;
        worker = null;
        if (dead) void dead.terminate();
        reject(
          err.computeBudgetExceeded("regex execution exceeded its time budget", {
            timeout_ms: timeoutMs,
            pattern,
          }),
        );
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, ...job });
  });
}

/**
 * One-time readiness handshake. Construction alone is not enough — the realistic failure mode
 * is the embedded source failing at runtime inside the worker — so a ping must round-trip
 * before the worker path is trusted. Latched: probed once per process.
 */
export async function regexWorkerAvailable(): Promise<boolean> {
  if (capable !== null) return capable;
  try {
    await post({ ping: true }, 1000, "");
    capable = true;
  } catch {
    capable = false;
    const dead = worker;
    worker = null;
    if (dead) void dead.terminate();
  }
  return capable;
}

/**
 * Scan one file's lines in the worker under `remainingMs` of budget. Throws the non-retryable
 * `compute_budget_exceeded` on overrun. Jobs from concurrent calls share the one worker and
 * serialize; a timeout terminates the shared worker (acceptable v1 semantics — a queued job
 * then settles via its own deadline).
 */
export function execRegexJob(job: RegexJob, remainingMs: number): Promise<WorkerHit[]> {
  return post(job, remainingMs, job.pattern);
}
