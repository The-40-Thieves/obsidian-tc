// A delay that ends the moment `signal` aborts, with its timer cleared: resolves (never rejects),
// so the caller's own loop decides what an abort means. Shared by the embed pacer and the provider
// clients' retry backoff (a caller's deadline must not leave a 60 s `Retry-After` sleep behind).
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
