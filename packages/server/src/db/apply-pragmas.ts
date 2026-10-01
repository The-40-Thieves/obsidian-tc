import { connectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from "./pragmas";
import { busyReason } from "./txn";

const SQLITE_IOERR = 10;
const SQLITE_IOERR_TRUNCATE = SQLITE_IOERR | (6 << 8); // 1546

/**
 * True for the one non-BUSY failure a cold boot is known to hit on Windows: `SQLITE_IOERR_TRUNCATE`
 * ("disk I/O error") from `PRAGMA journal_mode = WAL`. Several processes converting the same fresh
 * file race: a sibling that already finished has the main db file memory-mapped (`mmap_size` is
 * applied right after the WAL switch), and Windows refuses `SetEndOfFile` on a file with a user
 * mapping in another process, which is how SQLite's commit path sizes the file. Measured on
 * windows-latest with the cold-boot stress test: 15 of 14,400 iterations, always at that pragma, no
 * failure without Windows. The pager rolls the half-made conversion back (the journal is still
 * present), so once the sibling has converted the file the pragma is a no-op and a retry succeeds.
 * Off Windows the same code is a genuine disk fault and must surface at once. Matched by name
 * (bun:sqlite, better-sqlite3) or by number (node:sqlite exposes only `errcode`).
 */
function isTransientWindowsIoErr(e: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32" || e === null || typeof e !== "object") return false;
  const x = e as { code?: unknown; errcode?: unknown; errno?: unknown };
  return (
    x.code === "SQLITE_IOERR_TRUNCATE" ||
    x.errcode === SQLITE_IOERR_TRUNCATE ||
    x.errno === SQLITE_IOERR_TRUNCATE
  );
}

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
 *
 * On Windows the same budgeted retry also covers `isTransientWindowsIoErr`. A failure that is not
 * retried (or outlasts the budget) is tagged with the pragma that raised it (`error.pragma`), so a
 * log names the call that failed rather than just "disk I/O error".
 */
export function applyConnectionPragmas(
  run: (pragma: string) => void,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
): void {
  const deadline = Date.now() + busyTimeoutMs;
  for (const p of connectionPragmas(busyTimeoutMs)) {
    for (let attempt = 0; ; attempt++) {
      try {
        run(p);
        break;
      } catch (e) {
        const transient = busyReason(e) !== null || isTransientWindowsIoErr(e, platform);
        if (!transient || Date.now() >= deadline) {
          if (e !== null && typeof e === "object") (e as { pragma?: string }).pragma = p;
          throw e;
        }
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

/**
 * `applyConnectionPragmas` for a handle the caller just opened: if a pragma throws (a file that is
 * not a database fails on the FIRST statement, "file is not a database"), close the handle before
 * the error propagates. An adapter that let it escape left the connection open until GC, and on
 * Windows an open handle makes the file undeletable: a corrupt cache.db could not be removed by the
 * caller that had already handled the failure. The original error is rethrown; a close that itself
 * throws is ignored, since the open failure is the one worth reporting.
 */
export function applyConnectionPragmasOrClose(
  db: { close(): void },
  run: (pragma: string) => void,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): void {
  try {
    applyConnectionPragmas(run, busyTimeoutMs);
  } catch (e) {
    try {
      db.close();
    } catch {
      // keep the open failure as the reported error
    }
    throw e;
  }
}
