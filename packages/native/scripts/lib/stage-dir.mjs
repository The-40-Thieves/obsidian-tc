// Per-invocation staging directory management for scripts/build.mjs (THE-1080, #948).
//
// A single shared `target/napi-stage` directory, rm -rf'd unconditionally on every invocation, lets
// two concurrent builds in one checkout (debug + release for different targets, or CI matrix jobs
// sharing a workspace) delete each other's staging output or promote the wrong artifact. Each
// invocation now gets its own uniquely-named `target/napi-stage-<random>` directory via mkdtemp,
// which avoids that collision by construction rather than by locking.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const STAGE_DIR_PREFIX = "napi-stage-";

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Creates a fresh, uniquely-named staging directory under `targetDir`. `mkdtempFn` defaults to
 * `node:fs`'s `mkdtempSync` and is injectable so a test can assert two calls never collide without
 * touching the real filesystem twice in the same process. */
export function createStageDir(targetDir, mkdtempFn = mkdtempSync) {
  return mkdtempFn(join(targetDir, STAGE_DIR_PREFIX));
}

/**
 * Best-effort removal of `napi-stage-*` directories under `targetDir` older than `maxAgeMs`
 * (default 1 hour) -- leftovers from a killed or crashed prior invocation (e.g. a `--watch` build.mjs
 * rejects outright, but an older checkout or a hard `kill -9` mid-build could still leave one).
 * Never throws: a missing `targetDir`, a permission error, or a directory a still-live invocation
 * owns is left alone rather than failing the current build over stale housekeeping.
 */
export function sweepStaleStageDirs({
  targetDir,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  readdirFn = readdirSync,
  statFn = statSync,
  rmFn = rmSync,
}) {
  let entries;
  try {
    entries = readdirFn(targetDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGE_DIR_PREFIX)) {
      continue;
    }
    const dirPath = join(targetDir, name);
    try {
      if (now - statFn(dirPath).mtimeMs > maxAgeMs) {
        rmFn(dirPath, { recursive: true, force: true });
      }
    } catch {
      // best effort only -- see the docstring above
    }
  }
}
