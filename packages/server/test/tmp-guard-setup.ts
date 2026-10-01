// Per-test-file half of the temp-dir leak gate (tmp-guard-global-setup.ts): point TMPDIR at a
// subdirectory of the run's private root named after THIS test file, so anything the file leaves
// behind is reported against it. Must be the FIRST `setupFiles` entry: tmpdir-realpath-setup.ts and
// home-isolation-setup.ts both read `tmpdir()` and must land under the per-file directory.
//
// No-op when the globalSetup is absent (an IDE runner that skips it).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { fileSlug, TMP_GUARD_ROOT_ENV } from "./tmp-guard";

const runRoot = process.env[TMP_GUARD_ROOT_ENV];
if (runRoot) {
  const dir = join(runRoot, fileSlug(expect.getState().testPath, process.cwd()));
  mkdirSync(dir, { recursive: true });
  process.env.TMPDIR = dir;
  if (process.platform === "win32") {
    process.env.TMP = dir;
    process.env.TEMP = dir;
  }
}
