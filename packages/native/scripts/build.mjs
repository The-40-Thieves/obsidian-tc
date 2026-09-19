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
import { fileURLToPath } from "node:url";
import { ArtifactCopyError, copyArtifactIfChanged } from "./lib/artifact-copy.mjs";
import { buildNapiBuildInvocation } from "./lib/napi-invocation.mjs";

const fsImpl = { existsSync, readFileSync, copyFileSync, renameSync, unlinkSync };

const nativeDir = dirname(dirname(fileURLToPath(import.meta.url)));
const targetDir = join(nativeDir, "target");
const stageDir = join(targetDir, "napi-stage");

mkdirSync(targetDir, { recursive: true });
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const invocation = buildNapiBuildInvocation({
  nativeDir,
  targetDir,
  stageDir,
  extraArgs: process.argv.slice(2),
});

const build = spawnSync(invocation.command, invocation.args, invocation.options);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const artifacts = readdirSync(stageDir).filter((f) => f.endsWith(".node"));
if (artifacts.length === 0) {
  console.error(`native build: napi build produced no .node file in ${stageDir}`);
  process.exit(1);
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
    console.log(
      result.action === "skipped"
        ? `native build: ${name} unchanged, copy skipped`
        : `native build: updated ${name}`,
    );
  } catch (err) {
    if (err instanceof ArtifactCopyError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
