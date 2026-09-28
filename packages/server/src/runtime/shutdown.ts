// WP5.2 (issue 16): run_serve's SIGTERM/SIGINT registration, extracted out of cli.ts so the
// signal-to-shutdown wiring is a unit on its own rather than two `process.on` calls buried at the
// bottom of a 1000-line boot function. `ServerRuntime.close(reason)` itself is idempotent
// (server-runtime.ts guards it with a `closed` flag, so every caller — a signal, a test, a future
// second signal — gets the same safe behaviour); this module's own `shuttingDown` guard exists so a
// SECOND signal arriving while the first is still draining does not race a second `close()` call
// and a second `process.exit(0)` into the same shutdown.
import type { ServerRuntime } from "./server-runtime";
import { logShutdownError } from "./shutdown-phase";

// GH #995: `close()` is bounded internally (its own SHUTDOWN_DRAIN_MS race and
// scheduler.stop()'s own deadline), but "every piece we wrote is bounded" is not the same
// guarantee as "the whole call is bounded" — an unforeseen hang anywhere in the close/drain chain
// (this ticket's own bug was exactly that: a pass nothing here awaited or could cancel) would
// otherwise leave the process needing SIGKILL again. This is last-resort insurance, armed the
// moment a signal is actually being handled, generous enough that it never fires on a normal
// bounded close (SHUTDOWN_DRAIN_MS + the scheduler's own deadline is 10s in the worst case today).
const HARD_EXIT_MS = 15_000;

/**
 * Register SIGTERM/SIGINT to run `runtime.close(<signal reason>)` then exit 0. Returns a disposer
 * that removes both listeners — production never calls it (the process exits first); tests do, so
 * they can install/uninstall without leaking listeners across cases.
 */
export function installShutdownSignals(runtime: ServerRuntime): () => void {
  let shuttingDown = false;
  const makeHandler = (signal: NodeJS.Signals): (() => void) => {
    return (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      // hard-exit fallback: armed here, at signal time, and cleared the moment close() actually
      // settles below — .unref() so an already-scheduled fallback never keeps a healthy process
      // alive on its own.
      const hardExit: NodeJS.Timeout = setTimeout(() => {
        process.stderr.write(
          `shutdown: close() did not finish within ${HARD_EXIT_MS}ms of ${signal} — forcing exit\n`,
        );
        process.exit(1);
      }, HARD_EXIT_MS).unref();
      void runtime
        .close(`signal:${signal}`)
        .catch(logShutdownError)
        .finally(() => {
          clearTimeout(hardExit);
          process.exit(0);
        });
    };
  };
  const onSigterm = makeHandler("SIGTERM");
  const onSigint = makeHandler("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  return () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
}
