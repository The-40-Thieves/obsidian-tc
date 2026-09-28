// GH #995 follow-up: pace the boot/promotion/periodic reconcile's embed pass so it stops
// competing with interactive tool calls for the CPU-bound in-process embed step (the in-process
// ONNX/native path runs synchronously on the JS thread for its whole duration — see
// embed-batches.ts's own GH #995 comment on the worker loop's setImmediate yield).
// #996/#997/#998/#999 already fixed thread caps, abortability, one-leader-per-vault and sticky
// provider; this closes the remaining gap: the leader's reconcile still ran its embed pass at full
// speed the instant it started.
//
// Fix round (Codex review on #1003): the original idle-only gate had no progress floor (ordinary
// polling traffic, or a hung handler, could defer a sub-batch forever — see `waitForIdle`'s own
// `maxDeferMs` doc below) and let every worker/vault pass the gate independently in the same
// microtask, bursting up to `concurrency * vaultCount` sub-batches before a newly arrived request
// was even counted (see `serializeAdmission` below).
//
// Deliberately pure and dependency-free (no import of workspace/sessions.ts or any global state)
// so `waitForIdle` is directly unit-testable with an injected clock/gate/signal — the real
// `IdleGate` (backed by the process-wide dispatch counter) is wired up at the composition root
// (runtime/plane-wiring.ts's createReconcileRunner), never constructed here.

/** What `waitForIdle` needs to know about the server's live dispatch activity. Implemented by the
 *  composition root against workspace/sessions.ts's process-wide dispatch counter — see
 *  runtime/plane-wiring.ts. */
export interface IdleGate {
  /** True while at least one MCP tool call is currently in flight, process-wide. */
  isBusy(): boolean;
  /** Milliseconds since the last dispatch activity (a call starting or finishing), process-wide.
   *  `Number.POSITIVE_INFINITY` when no dispatch has happened yet this process — i.e. immediately
   *  idle, never blocking on a server that has served no calls at all. */
  idleForMs(now: number): number;
}

/** How often `waitForIdle` re-checks the gate while waiting. Small enough that `idleMs` is honored
 *  to within a tick; large enough not to spin. Not configurable — this is a poll granularity, not
 *  a tunable knob a config key would meaningfully change. */
const DEFAULT_POLL_MS = 50;

// Process-wide, best-effort "is the background embed currently paused for idle" flag, read by the
// obsidian_tc_background_embed_paused gauge (metrics/registry.ts via runtime/observability.ts).
// Only set while a `waitForIdle` call is ACTUALLY waiting (the gate was busy or not idle long
// enough on entry) — a call that finds the server already idle never flips this, so the gauge
// reads 0 on the overwhelmingly common "nothing to pace" pass. Module-level rather than threaded
// through embed-batches.ts's return value: this is an observability side-channel, not part of the
// paced embed loop's own contract, and every consumer of `waitForIdle` already has a live signal
// to abort on — adding a second output channel to the function itself would only complicate
// callers that don't care.
let waiting = 0;

/** True while at least one `waitForIdle` call is genuinely blocked (not merely checking). */
export function isBackgroundEmbedPaused(): boolean {
  return waiting > 0;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Fix round (Codex review on #1003 verify-r2, medium finding 1): addEventListener above does
    // NOT invoke onAbort for a signal that was already aborted before this call — DOM/Node's
    // AbortSignal only fires "abort" at the moment abort() runs, never retroactively for a
    // listener added afterward. waitForIdle's loop only checks `signal?.aborted` BEFORE calling
    // this function, so a signal aborted in the gap between that check and this call would
    // otherwise sit through the full `ms` timer before resolving. Re-check synchronously right
    // after subscribing to close that gap.
    if (signal?.aborted) {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve();
    }
  });
}

// Fix round (Codex review on #1003, HIGH finding 1): the plain idle-quiet-window gate above has no
// progress floor. Every dispatch (a call STARTING or finishing — see markDispatchActive) resets
// the quiet window, so a client polling anything faster than `idleMs` — an entirely ordinary,
// healthy traffic pattern (server_health, task-status polling, ...) — can defer every remaining
// sub-batch forever; a handler that stops observing its own abort signal makes this worse, since
// `isBusy()` alone then never clears either. `maxDeferMs`, when passed, bounds that: once a call
// has been continuously deferred for `maxDeferMs`, it stops requiring a quiet window and instead
// admits the next sub-batch as soon as no call is CURRENTLY in flight (`isBusy()` false) — still
// fair to an ordinary busy-but-not-hung server, since it waits for that in-flight call to actually
// finish rather than barging in on it. If `isBusy()` never clears at all (the hung-handler case),
// a second, harder cap at `maxDeferMs * HARD_CAP_MULTIPLIER` admits unconditionally, in-flight or
// not — chosen as a plain multiple of the caller's own configured floor (rather than a separate
// knob) so a hung handler cannot block reconcile progress forever, while still giving the in-flight
// call one full extra `maxDeferMs` window to finish normally before this forces through. `signal`
// still wins over both — an abort always exits immediately, deferral floor or not. Absent (the
// default) preserves the exact pre-fix-round behavior: wait for a genuine quiet window, no matter
// how long that takes.
const HARD_CAP_MULTIPLIER = 2;

/**
 * Block until `gate` reports the server idle for at least `idleMs`, or `signal` aborts —
 * whichever comes first. "Idle" means both: no call currently in flight, AND at least `idleMs`
 * since the last dispatch activity (a call starting counts too, so a call that started but has not
 * finished yet keeps this waiting even though `isBusy()` alone would already cover that case — the
 * two checks are deliberately redundant against a gate implementation that only tracks one of
 * them).
 *
 * Returns immediately (no poll, no wait) when the gate is already idle on entry — the common case
 * for a small vault or a quiet server, and byte-identical in cost to not calling this at all.
 * Returns immediately on an already-aborted signal, never entering the poll loop.
 *
 * `maxDeferMs` (optional; absent -> unbounded, matching the pre-fix-round contract exactly) is the
 * bounded-fairness floor described above — see that comment for the two-tier admission it applies
 * once a wait has run that long.
 */
export async function waitForIdle(
  gate: IdleGate,
  idleMs: number,
  signal?: AbortSignal,
  now: () => number = Date.now,
  pollMs: number = DEFAULT_POLL_MS,
  maxDeferMs?: number,
): Promise<void> {
  if (signal?.aborted) return;
  if (!gate.isBusy() && gate.idleForMs(now()) >= idleMs) return;
  const deferStart = now();
  waiting += 1;
  try {
    while (!signal?.aborted) {
      if (!gate.isBusy() && gate.idleForMs(now()) >= idleMs) return;
      if (maxDeferMs !== undefined) {
        const deferredFor = now() - deferStart;
        if (deferredFor >= maxDeferMs && !gate.isBusy()) return;
        if (deferredFor >= maxDeferMs * HARD_CAP_MULTIPLIER) return;
      }
      await sleepAbortable(pollMs, signal);
    }
  } finally {
    waiting -= 1;
  }
}

// Fix round (Codex review on #1003, HIGH finding 2): each of `concurrency` embed workers
// (embed-batches.ts) and each vault's reconcile (plane-wiring.ts's `Promise.all`) call the SAME
// `pace()` closure independently. When the gate is already idle, `waitForIdle` above resolves on
// its very first synchronous check — no `await` runs before that return — so every one of those
// callers can pass the gate inside the SAME microtask, before a newly arrived dispatch call is even
// counted (libuv never gets a turn to deliver it). `serializeAdmission` is the process-wide fix:
// it forces every paced admission, across every worker and every vault's reconcile, through ONE
// FIFO queue, and inserts a real macrotask yield (`setImmediate`) after each admission resolves and
// before the next one is even attempted — so a request that arrives during that yield is counted
// before the next sub-batch is allowed to start. Module-level (like `waiting` above) rather than
// threaded through deps: this is a serialization primitive for the paced path as a whole, not a
// per-call-site knob, and every paced caller already shares this module.
let admissionChain: Promise<void> = Promise.resolve();

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run `fn` (a single paced admission, e.g. one `waitForIdle` call) after every previously queued
 * admission has resolved AND yielded one macrotask turn. Returns `fn`'s own result/rejection to the
 * caller unchanged — only the ORDERING and the forced yield are this function's business; a
 * rejection does not poison the shared queue for callers still waiting behind it.
 */
export function serializeAdmission<T>(fn: () => Promise<T>): Promise<T> {
  const turn = admissionChain;
  const result = turn.then(fn, fn);
  admissionChain = result.then(yieldMacrotask, yieldMacrotask);
  return result;
}
