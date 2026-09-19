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
// when the bytes already match and failing with a named errno + path (plus a Windows-specific
// hint) when a lock blocks the real copy.
//
// `--js`/`--dts` are resolved with `path.join(outputDir, ...)` internally (measured: passing an
// absolute path there produces a mangled, doubled-up path, not the absolute path itself) -- so
// they're computed here as paths RELATIVE TO stageDir that walk back out to targetDir. That keeps
// the generated js/dts landing at the exact same packages/native/target/ location as before this
// wrapper existed, regardless of where `--output-dir` points the `.node` file.
//
// All argv this script receives is forwarded to `napi build` verbatim (after the fixed flags
// below) -- ci-native.yml and publish.yml both do `bun run build -- --target <triple> [-x]`, and
// that passthrough must keep working unchanged.
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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCopyError, copyArtifactIfChanged } from "./lib/artifact-copy.mjs";

const fsImpl = { existsSync, readFileSync, copyFileSync, renameSync, unlinkSync };

const nativeDir = dirname(dirname(fileURLToPath(import.meta.url)));
const targetDir = join(nativeDir, "target");
const stageDir = join(targetDir, "napi-stage");

mkdirSync(targetDir, { recursive: true });
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const napiBin = join(
  nativeDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "napi.cmd" : "napi",
);

const args = [
  "build",
  "--platform",
  "--js",
  relative(stageDir, join(targetDir, "napi-generated.js")),
  "--dts",
  relative(stageDir, join(targetDir, "napi-generated.d.ts")),
  "--output-dir",
  stageDir,
  ...process.argv.slice(2),
];

const build = spawnSync(existsSync(napiBin) ? napiBin : "napi", args, {
  cwd: nativeDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
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
