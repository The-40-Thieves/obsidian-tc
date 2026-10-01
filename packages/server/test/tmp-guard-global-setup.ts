// vitest `globalSetup`: give the whole run a private temp root, and fail the run if any test file
// leaves something behind in it. See tmp-guard.ts for why this is not a before/after /tmp diff.
//
// Workers are spawned after this runs and inherit `process.env`, so pointing TMPDIR (TMP/TEMP on
// Windows) at the root contains every `os.tmpdir()` caller in the test files, in the src code they
// trigger, and in the CLIs they spawn. tmp-guard-setup.ts narrows it further to one directory per
// test file so a leak names its file.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatLeakReport,
  RUN_ROOT_PREFIX,
  scanLeaks,
  sweepStaleRunRoots,
  TMP_GUARD_ROOT_ENV,
} from "./tmp-guard";

// Vitest's own module-runner cache directory (`<tmpdir>/<nanoid>/ssr`, ~1-40 MB of transformed
// source) is created in the MAIN process before any config or globalSetup runs, and vitest 5.0.x
// never removes the one the core instance owns (only per-project dirs are cleared on close). Those
// are the 21-character nanoid directories that piled up in /tmp (1,957 of them on 2026-09-30). The
// path is an `@internal` field, so it is read defensively and only removed when it sits directly
// under the tmpdir this run started in.
function vitestOwnTmpDir(project: unknown): string | undefined {
  const vitest = (project as { vitest?: { _tmpDir?: unknown } } | undefined)?.vitest;
  return typeof vitest?._tmpDir === "string" ? vitest._tmpDir : undefined;
}

export default function setup(project?: unknown): () => void {
  const startTmp = tmpdir();
  const realTmp = realpathSync(startTmp);
  const vitestTmp = vitestOwnTmpDir(project);
  sweepStaleRunRoots(realTmp);
  const runRoot = mkdtempSync(join(realTmp, RUN_ROOT_PREFIX));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env[TMP_GUARD_ROOT_ENV] = runRoot;
  process.env.TMPDIR = runRoot;
  if (process.platform === "win32") {
    process.env.TMP = runRoot;
    process.env.TEMP = runRoot;
  }

  return function teardown(): void {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env[TMP_GUARD_ROOT_ENV];
    const leaks = scanLeaks(runRoot);
    // Delete BEFORE reporting: the point of the gate is to fail, not to fill the disk (a leaked
    // 600 MB stage copy per run is how / got to 97%).
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (vitestTmp && [startTmp, realTmp].includes(dirname(vitestTmp))) {
      rmSync(vitestTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    if (leaks.length > 0) {
      process.exitCode = 1;
      throw new Error(`[tmp-guard] ${formatLeakReport(leaks)}`);
    }
  };
}
