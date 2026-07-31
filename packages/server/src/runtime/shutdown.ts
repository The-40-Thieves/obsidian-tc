// WP5.2 (issue 16): run_serve's SIGTERM/SIGINT registration, extracted out of cli.ts so the
// signal-to-shutdown wiring is a unit on its own rather than two `process.on` calls buried at the
// bottom of a 1000-line boot function. `ServerRuntime.close(reason)` itself is idempotent
// (server-runtime.ts guards it with a `closed` flag, so every caller — a signal, a test, a future
// second signal — gets the same safe behaviour); this module's own `shuttingDown` guard exists so a
// SECOND signal arriving while the first is still draining does not race a second `close()` call
// and a second `process.exit(0)` into the same shutdown.
import type { ServerRuntime } from "./server-runtime";

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
      void runtime
        .close(`signal:${signal}`)
        .catch((e) => {
          process.stderr.write(
            `shutdown: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
          );
        })
        .finally(() => {
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
