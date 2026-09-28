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

// Fix round 2 (Codex review 1001-verify-r2), CI part B: `os.homedir()` reads `HOME` on POSIX but
// NEVER consults it on Windows — there it reads `USERPROFILE` (then HOMEDRIVE+HOMEPATH). A test
// that only sets `process.env.HOME = tmpDir` to sandbox `homedir()`-dependent code (setup's own
// `defaultSetupConfigPath`, `resolveCapabilityProfile`, ...) has NO effect on windows-latest: every
// such assertion resolves against the REAL runner profile dir instead of the test's own temp dir.
// Reproduced directly in CI (windows-latest, cli-args.test.ts's default-path suite and
// setup-e2e.test.ts's whole file). Set BOTH env vars unconditionally so one call point sandboxes
// `homedir()` on every OS this repo's CI covers — a POSIX box simply ignores USERPROFILE.

/** Points `os.homedir()` at `dir` for the duration of a test. Returns a restore function; call it
 *  in `afterEach` (never a whole `process.env = {...}` reassignment — see setup-e2e.test.ts's own
 *  header on why that breaks `homedir()`'s caching invalidation hook). */
export function stubHomedir(dir: string): () => void {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  };
}
