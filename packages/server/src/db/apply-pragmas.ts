import { connectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from "./pragmas";
import { busyReason } from "./txn";

/**
 * Apply `connectionPragmas` through `run`, retrying a pragma that fails SQLITE_BUSY until
 * `busyTimeoutMs` has elapsed in total.
 *
 * `busy_timeout` being first (see pragmas.ts) is necessary but not sufficient on a COLD boot. Several
 * processes opening the same brand-new file at once each try to convert it to WAL, and SQLite
 * deliberately does NOT invoke the busy handler when waiting could deadlock — a connection holding
 * a SHARED lock that needs to upgrade while another holds PENDING gets SQLITE_BUSY at once, however
 * long `busy_timeout` is. Measured with 4 concurrent bun processes on a fresh cacheDir: about 1 open
 * in 50 threw "database is locked" straight out of the adapter. Once the file is WAL the pragma is a
 * no-op, so the window closes after the first boot; retrying just rides it out. Any non-busy error
 * propagates immediately, and the LAST busy error is rethrown once the budget is spent.
 */
export function applyConnectionPragmas(
  run: (pragma: string) => void,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): void {
  const deadline = Date.now() + busyTimeoutMs;
  for (const p of connectionPragmas(busyTimeoutMs)) {
    for (let attempt = 0; ; attempt++) {
      try {
        run(p);
        break;
      } catch (e) {
        if (busyReason(e) === null || Date.now() >= deadline) throw e;
        // Bounded, jittered sync backoff (the adapters' open path is synchronous throughout).
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          2 + Math.random() * 8 * Math.min(attempt + 1, 5),
        );
      }
    }
  }
}
