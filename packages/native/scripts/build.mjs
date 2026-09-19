#!/usr/bin/env bun
// Wrapper around `napi build` (THE-1080, #948).
//
// On Windows, when an MCP client (e.g. Claude Code, via dist/cli.js) still has
// packages/native/*.node loaded, napi's own post-build artifact copy fails with
// "Internal Error: Failed to copy artifact" -- no errno, no path -- even when the freshly built
// bytes are byte-identical to what's already there. Per napi-rs's own troubleshooting docs
// ("Cargo succeeds but NAPI-RS cannot copy the artifact"), the fix is to stop racing napi's copy
// step against a loaded file: build into a private staging directory via `--output-dir` ("Path to
// where all the built files would be put. Default to the crate folder" -- `napi build --help`,
// @napi-rs/cli 3.7.2), then copy from staging into place ourselves, skipping the write entirely
// when the bytes already match and failing with a named errno + path (plus a platform-specific
// hint) when a lock blocks the real copy. See lib/artifact-copy.mjs for that decision.
//
// The `napi build` process itself is spawned via lib/napi-invocation.mjs's argv builder --
// `process.execPath` on @napi-rs/cli's own JS entry point, `shell: false` on every platform. Never
// spawn it with `shell: true`: an args array through a shell is space-joined without quoting
// (Node's own child_process docs; DEP0190), so a stageDir path containing a space -- Windows
// `C:\Users\Jane Doe\...`, a OneDrive sync folder -- would silently split into multiple shell
// tokens and break `--output-dir`, on exactly the machines this fix targets. See that module's
// header for the full rationale.
//
// `--watch`/`-w` is REJECTED (see lib/napi-invocation.mjs's hasWatchFlag): this wrapper waits
// synchronously for `napi build` to exit before promoting the staged artifact, which is
// fundamentally incompatible with napi's own continuous-rebuild watch mode -- nothing in this repo
// drives it through `bun run build`/`build:debug` today (checked: no napi `--watch`/`-w` reference
// in package.json, .github, docs, or the justfile), so reject-with-a-pointer beats silently never
// promoting a rebuild.
//
// Each invocation stages into its OWN directory (lib/stage-dir.mjs, `mkdtemp`), not a single
// shared `target/napi-stage` -- two concurrent builds in one checkout (debug + release for
// different targets, or CI matrix jobs sharing a workspace) must not be able to delete each
// other's staging output or promote each other's artifact.
//
// All argv this script receives is forwarded to `napi build` verbatim (after the fixed flags
// added by buildNapiBuildInvocation) -- ci-native.yml and publish.yml both do `bun run build --
// --target <triple> [-x]`, and that passthrough must keep working unchanged.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArtifactCopyError, copyArtifactIfChanged } from "./lib/artifact-copy.mjs";
import {
  buildNapiBuildInvocation,
  hasWatchFlag,
  WATCH_NOT_SUPPORTED_MESSAGE,
} from "./lib/napi-invocation.mjs";
import { createStageDir, sweepStaleStageDirs } from "./lib/stage-dir.mjs";

/**
 * Runs `napi build` (via buildNapiBuildInvocation) into `stageDir` and promotes its artifacts into
 * `nativeDir`. ALWAYS removes `stageDir` before returning or throwing -- on a napi build failure,
 * a spawn failure, an artifact-count mismatch, a typed ArtifactCopyError, or any OTHER unexpected
 * throw (buildNapiBuildInvocation resolving no `bin.napi`, a non-lock error such as ENOSPC out of
 * copyArtifactIfChanged, readdirSync itself throwing). The single `finally` below is what
 * guarantees that -- everything that can fail after `stageDir` exists happens inside this
 * function's `try`, and nothing here ever calls `process.exit` (which would skip a pending
 * `finally`); it returns the process exit code instead, and the caller exits once, after this
 * function -- and its cleanup -- has already run.
 *
 * `spawnFn`/`fsImpl`/`log`/`errorLog` are injectable so tests can exercise every branch (including
 * the unexpected-throw one) without a real `napi build`, cargo, or a compiler.
 */
export function runBuild({
  nativeDir,
  targetDir,
  stageDir,
  extraArgs,
  spawnFn = spawnSync,
  fsImpl,
  log = console.log,
  errorLog = console.error,
}) {
  try {
    const invocation = buildNapiBuildInvocation({ nativeDir, targetDir, stageDir, extraArgs });

    const build = spawnFn(invocation.command, invocation.args, invocation.options);
    // spawnSync sets `error` (status stays null) when the child process never started at all --
    // e.g. the resolved @napi-rs/cli entry point doesn't exist. Report the real cause rather than
    // exiting silently on a null status.
    if (build.error) {
      errorLog(`native build: failed to start napi build: ${build.error.message}`);
      return 1;
    }
    if (build.status !== 0) {
      return build.status ?? 1;
    }

    const artifacts = fsImpl.readdirSync(stageDir).filter((f) => f.endsWith(".node"));
    if (artifacts.length === 0) {
      errorLog(`native build: napi build produced no .node file in ${stageDir}`);
      return 1;
    }

    for (const name of artifacts) {
      const destPath = join(nativeDir, name);
      try {
        const result = copyArtifactIfChanged({
          srcPath: join(stageDir, name),
          destPath,
          platform: process.platform,
          fsImpl,
        });
        log(
          result.action === "skipped"
            ? `native build: ${name} unchanged, copy skipped`
            : `native build: updated ${name}`,
        );
      } catch (err) {
        if (err instanceof ArtifactCopyError) {
          errorLog(err.message);
          return 1;
        }
        throw err;
      }
    }
    return 0;
  } finally {
    try {
      fsImpl.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      // best effort; a leftover here is swept by sweepStaleStageDirs on a future run
    }
  }
}

// Only run the script body when executed directly (`bun scripts/build.mjs`), not when a test
// imports this module for `runBuild`. The portable check: does this module's own URL match the
// URL of the file Node/Bun was actually launched with.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const fsImpl = {
    existsSync,
    readFileSync,
    copyFileSync,
    renameSync,
    unlinkSync,
    readdirSync,
    rmSync,
  };

  const nativeDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const targetDir = join(nativeDir, "target");

  mkdirSync(targetDir, { recursive: true });
  sweepStaleStageDirs({ targetDir });

  const extraArgs = process.argv.slice(2);

  // Rejected BEFORE a stage dir is even allocated -- hasWatchFlag is pure, so there is nothing to
  // clean up on this path. buildNapiBuildInvocation (inside runBuild) re-checks the same flag and
  // throws the same WATCH_NOT_SUPPORTED_MESSAGE (see lib/napi-invocation.mjs), so this is a
  // fast-path, not the only enforcement of the rejection.
  if (hasWatchFlag(extraArgs)) {
    console.error(WATCH_NOT_SUPPORTED_MESSAGE);
    process.exit(1);
  }

  const stageDir = createStageDir(targetDir);
  process.exit(runBuild({ nativeDir, targetDir, stageDir, extraArgs, fsImpl }));
}
