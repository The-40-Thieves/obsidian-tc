// GH #995: extracted out of server-runtime.ts's close() (which was pushing biome's 700-line
// noExcessiveLinesPerFile ceiling) rather than folded into shutdown.ts — shutdown.ts already
// carries a type-only import OF server-runtime.ts (`ServerRuntime`), and this helper is called
// FROM server-runtime.ts, so putting it there would round-trip the two modules into each other.
// Structural (duck) typing on the three params sidesteps importing Scheduler/IndexCoordinator/
// JobRunner's own types here at all — jobRunner in particular has no standalone exported type
// (it's an inline `Awaited<ReturnType<typeof wireJobHandlers>>["jobRunner"]` in server-runtime.ts).

/**
 * Race `scheduler.stop()`, then `indexCoordinator.idle()`, then `jobRunner.drainOnce()` against
 * ONE shared deadline — previously `scheduler.stop()` ran sequentially BEFORE a separate drain
 * race even started, so its own internal bound (scheduler.ts's `shutdownDeadlineMs`) could stack
 * with the drain's own bound instead of sharing one. `drainOnce` gets the same deadline's signal,
 * so a lease-grab in flight when the deadline fires stops rather than waiting out the drainMs
 * budget twice.
 */
/** F3 (fix round 2): the caller (server-runtime.ts's close()) must know whether the drain below
 *  actually finished or was cut off by its own deadline — "done" vs "timeout" mirrors
 *  `joinInFlightReconcile`'s own return shape below, so both timeout-shaped outcomes get the SAME
 *  treatment at the call site (exit rather than release, see `joinReconcileOrExit`'s doc). Previously
 *  this returned `void` unconditionally, so `close()` released the leader lock right after this
 *  settled regardless of whether `indexCoordinator.idle()` had actually drained. */
export async function raceShutdownPhase(opts: {
  scheduler: { stop(): Promise<void> };
  indexCoordinator: { idle(): Promise<void> };
  jobRunner: { drainOnce(signal: AbortSignal): Promise<void> };
  drainMs: number;
}): Promise<"done" | "timeout"> {
  const { scheduler, indexCoordinator, jobRunner, drainMs } = opts;
  const phaseAbort = new AbortController();
  const phaseTimer = setTimeout(() => phaseAbort.abort(), drainMs).unref();
  const outcome = await Promise.race([
    (async (): Promise<"done"> => {
      await scheduler.stop();
      await indexCoordinator.idle().catch(() => {});
      // #14: durable jobs survive the process exiting mid-lease (claim()'s lease-expiry reclaim
      // picks them up); this bounded best-effort pass just gives a live worker a chance to clear
      // the queue before exit instead of always waiting out the lease.
      await jobRunner.drainOnce(phaseAbort.signal).catch(() => {});
      return "done";
    })(),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), drainMs).unref();
    }),
  ]);
  clearTimeout(phaseTimer);
  return outcome;
}

/** F3 (fix round 2): thrown by both `raceShutdownPhaseOrExit` and `joinReconcileOrExit` after
 *  calling `exit(1)` — `process.exit` is documented to not return, but a TEST DOUBLE, or a
 *  genuinely delayed real exit under Bun, can. Throwing (rather than returning) means the caller's
 *  close() sequence — which releases the leader lock immediately after these calls — can never
 *  resume past a timeout with a drain/reconcile still possibly mid-write. Exported so a test can
 *  assert the specific failure mode rather than any thrown error. */
/** F3 (fix round 2): shared by shutdown.ts's SIGTERM/SIGINT handler AND server-runtime.ts's
 *  stdio-EOF `server.onclose` — both now `.catch()` a `close()` that can REJECT
 *  (ShutdownTimeoutExitError below) rather than always resolving. Lives here (not shutdown.ts) so
 *  server-runtime.ts can import it without round-tripping shutdown.ts's own type-only import OF
 *  server-runtime.ts — see this file's own extraction rationale at the top. */
export function logShutdownError(e: unknown): void {
  process.stderr.write(`shutdown: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
}

export class ShutdownTimeoutExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShutdownTimeoutExitError";
  }
}

/** F3 (fix round 2): `raceShutdownPhase` wrapper that exits (and throws — see
 *  `ShutdownTimeoutExitError`) on a "timeout" outcome instead of returning control to a caller
 *  that would otherwise proceed to release the leader lock with `indexCoordinator`/`jobRunner`
 *  possibly still mid-drain. Mirrors `joinReconcileOrExit`'s own shape exactly, so close() treats
 *  both timeout-shaped drains identically. */
export async function raceShutdownPhaseOrExit(
  opts: Parameters<typeof raceShutdownPhase>[0],
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  const outcome = await raceShutdownPhase(opts);
  if (outcome === "timeout") {
    const message =
      "obsidian-tc: shutdown drain (scheduler/index-coordinator/job-runner) still running past the deadline; exiting without a clean lock release (GH #995)\n";
    process.stderr.write(message);
    exit(1);
    throw new ShutdownTimeoutExitError(message);
  }
}

/**
 * SHUTDOWN_RECONCILE_OVERLAP (GH #995 fix round): joins a possibly-in-flight reconcile run
 * (`gateReconcileByLeader`'s exposed `GatedReconcile.currentRun()`) bounded by `deadlineMs`.
 * Previously the boot/promotion reconcile was fire-and-forget with no join surface at all —
 * `close()` released the leader lock the instant `raceShutdownPhase` above settled, regardless of
 * whether a reconcile pass (a fresh vault walk with its own commits) was still mid-write. A
 * successor could then promote and start its OWN reconcile while this process's writes were still
 * landing — two processes writing the same cache.db concurrently, exactly what the lock exists to
 * prevent.
 *
 * Returns `"done"` once the run settles (or immediately, if nothing was in flight) — `"timeout"` if
 * `deadlineMs` elapses first. The caller (server-runtime.ts's `close()`) must NOT release the
 * leader lock on a `"timeout"`: exiting the process instead lets the OS free the OS-level lock
 * (this module's own header comment) rather than this code releasing it while the reconcile is
 * still writing.
 */
export async function joinInFlightReconcile(
  inFlight: Promise<void> | undefined,
  deadlineMs: number,
): Promise<"done" | "timeout"> {
  if (!inFlight) return "done";
  return Promise.race([
    inFlight.then(
      () => "done" as const,
      () => "done" as const,
    ),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), deadlineMs).unref();
    }),
  ]);
}

/**
 * server-runtime.ts's close()-path wrapper around `joinInFlightReconcile` above — extracted
 * alongside it (same reason: server-runtime.ts's own 700-line noExcessiveLinesPerFile ceiling)
 * rather than left inline. Exits the process on a "timeout" outcome rather than returning control:
 * the caller must NEVER release the leader lock while a reconcile is still writing (see
 * `joinInFlightReconcile`'s doc above), and process death is the only way to free the OS-level
 * lock without racing that write. `exit` is injectable so a test can observe the call without
 * actually killing the test process; production omits it and gets the real `process.exit`.
 */
export async function joinReconcileOrExit(
  inFlight: Promise<void> | undefined,
  deadlineMs: number,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  const outcome = await joinInFlightReconcile(inFlight, deadlineMs);
  if (outcome === "timeout") {
    const message =
      "obsidian-tc: shutdown reconcile still in flight past the drain deadline; exiting without a clean lock release (GH #995)\n";
    process.stderr.write(message);
    exit(1);
    // F3 (fix round 2): never trust `exit` to actually terminate — see ShutdownTimeoutExitError's
    // own doc above. A caller that used to fall through here (a test double, or Bun's delayed
    // real exit) previously reached the leader-lock release right after this call with the
    // reconcile still possibly mid-write — the exact SHUTDOWN_RECONCILE_OVERLAP this exists to
    // prevent.
    throw new ShutdownTimeoutExitError(message);
  }
}
