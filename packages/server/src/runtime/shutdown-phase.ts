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
export async function raceShutdownPhase(opts: {
  scheduler: { stop(): Promise<void> };
  indexCoordinator: { idle(): Promise<void> };
  jobRunner: { drainOnce(signal: AbortSignal): Promise<void> };
  drainMs: number;
}): Promise<void> {
  const { scheduler, indexCoordinator, jobRunner, drainMs } = opts;
  const phaseAbort = new AbortController();
  const phaseTimer = setTimeout(() => phaseAbort.abort(), drainMs).unref();
  await Promise.race([
    (async () => {
      await scheduler.stop();
      await indexCoordinator.idle().catch(() => {});
      // #14: durable jobs survive the process exiting mid-lease (claim()'s lease-expiry reclaim
      // picks them up); this bounded best-effort pass just gives a live worker a chance to clear
      // the queue before exit instead of always waiting out the lease.
      await jobRunner.drainOnce(phaseAbort.signal).catch(() => {});
    })(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, drainMs).unref();
    }),
  ]);
  clearTimeout(phaseTimer);
}
