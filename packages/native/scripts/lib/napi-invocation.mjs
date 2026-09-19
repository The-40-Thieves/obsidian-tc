// Builds the `napi build` spawn invocation for scripts/build.mjs (THE-1080, #948).
//
// The previous version of this wrapper spawned `node_modules/.bin/napi` with `shell: true` on
// win32. Passing an ARGS ARRAY through a shell space-joins the arguments without quoting them
// (Node's own child_process docs; triggers runtime deprecation DEP0190) -- so `--output-dir
// <stageDir>` breaks silently the moment `stageDir` (an absolute path under the checkout) contains
// a space, e.g. Windows `C:\Users\Jane Doe\...` or a OneDrive-synced path. That is exactly the
// class of machine THE-1080 targets, so a shell can never be used here.
//
// Instead, resolve @napi-rs/cli's own JS entry point (its package.json `bin.napi` field) and run
// it directly with `process.execPath` (bun or node) and a plain argv array, `shell: false` on
// every platform -- no shell, no quoting problem, on any OS.
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

/** Resolves the on-disk path to @napi-rs/cli's `napi` CLI script via its own package.json `bin`
 * field. `requireFn` defaults to a `createRequire` bound to this module, and is injectable so
 * tests can exercise the argv builder below without needing the real package on disk. */
export function resolveNapiCliBin(requireFn = createRequire(import.meta.url)) {
  const pkgPath = requireFn.resolve("@napi-rs/cli/package.json");
  const pkg = requireFn(pkgPath);
  const binField = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.napi;
  if (!binField) {
    throw new Error('napi build: @napi-rs/cli package.json has no "bin.napi" entry');
  }
  return join(dirname(pkgPath), binField);
}

/**
 * Pure builder for the `napi build` spawn call -- no spawning, no fs access beyond `requireFn`'s
 * module resolution, so it's testable with a plain object stageDir/targetDir and a fake
 * `requireFn`. Returns `{ command, args, options }` ready to pass to `child_process.spawnSync`
 * (or an injectable stand-in in a test).
 */
export function buildNapiBuildInvocation({ nativeDir, targetDir, stageDir, extraArgs, requireFn }) {
  const napiCliBin = resolveNapiCliBin(requireFn);
  const args = [
    napiCliBin,
    "build",
    "--platform",
    "--js",
    relative(stageDir, join(targetDir, "napi-generated.js")),
    "--dts",
    relative(stageDir, join(targetDir, "napi-generated.d.ts")),
    "--output-dir",
    stageDir,
    ...extraArgs,
  ];
  return {
    command: process.execPath,
    args,
    // shell MUST stay false -- see the module header. Each element of `args` (stageDir in
    // particular) is passed to the child process verbatim, unaffected by spaces.
    options: { cwd: nativeDir, stdio: "inherit", shell: false },
  };
}
