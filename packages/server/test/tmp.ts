// Temp-directory teardown that survives Windows.
//
// Windows refuses to delete a file that still has an open handle. A SQLite handle the test (or the
// code under test) has not closed yet makes `rmSync` throw EPERM/EBUSY in `afterEach`, failing the
// suite in TEARDOWN even though every assertion passed — the observed shape of the windows-latest
// flakes was `Tests 1 failed | 3078 passed`, where the one failure was the cleanup itself. POSIX
// unlinks an open file happily, which is why this never reproduced on ubuntu or macOS.
//
// `force: true` is not the fix: it suppresses ENOENT, never EPERM. Node's own retry options are —
// `rmSync` retries on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM with a linear backoff, so a handle
// released moments later (an async close, a GC, an antivirus scan) no longer fails the run.
//
// Closing handles deliberately is still better where a suite owns them; this is the backstop that
// makes the whole class self-healing instead of fixing suites one at a time as they flake.
import { rmSync } from "node:fs";

/** Recursively remove a test temp dir, retrying the Windows file-lock errors. */
export function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
