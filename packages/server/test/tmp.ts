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
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Directories made by `makeTempDir` that nobody has removed yet.
const live = new Set<string>();

/** Recursively remove a test temp dir, retrying the Windows file-lock errors. */
export function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  live.delete(dir);
}

/** The ONE way a test creates a scratch directory: `mkdtempSync(join(tmpdir(), prefix))`, plus a
 *  guarantee it is removed when the test FILE ends (afterAll) or, failing that, when the process
 *  exits. A fixture that creates a directory per test and forgets one (a second cache dir beside
 *  the vault, a `finally` that an assertion skipped) used to leave it in /tmp forever; the run-wide
 *  gate in tmp-guard.ts now fails the suite for that, and this is what the fix routes through.
 *
 *  Call `rmTemp(dir)` yourself when a directory should go earlier (per-test fixtures with an
 *  afterEach keep doing so, which also keeps a long file's disk use flat). Removal is best-effort:
 *  a cleanup that throws would fail the suite in teardown with every assertion passing. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.add(dir);
  return dir;
}

/** Remove every entry in `tmpdir()` whose name starts with `prefix`. For directories made by the
 *  code UNDER test rather than by `makeTempDir` (a spawned CLI's sandbox, a collector's probe dir),
 *  which only the test knows to look for. `tmpdir()` is this test file's own directory under the
 *  run-wide gate, so nothing belonging to another file or process can match. Best-effort. */
export function sweepTempByPrefix(prefix: string): void {
  for (const name of readdirSync(tmpdir()).filter((n) => n.startsWith(prefix))) {
    try {
      rmTemp(join(tmpdir(), name));
    } catch (e) {
      console.warn(`[tmp] failed to clean up ${name}:`, e);
    }
  }
}

function sweepLive(): void {
  for (const dir of [...live]) {
    try {
      rmTemp(dir);
    } catch (e) {
      console.warn(`[tmp] failed to clean up temp dir ${dir}:`, e);
    }
  }
}

afterAll(sweepLive);
// Fallback for a worker that is torn down before (or without) afterAll: a file whose tests are all
// skipped never runs its hooks, and vitest ends its worker with SIGTERM, which does not emit "exit"
// at all. A signal handler replaces the default action, so it sweeps and then re-raises the signal
// to keep the process dying the way it would have. This is best-effort: the worker's kill can race
// the run-wide gate's scan (see ALLOWED_LEFTOVERS in tmp-guard.ts for the one dir that matters).
process.once("exit", sweepLive);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    sweepLive();
    process.kill(process.pid, signal);
  });
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
