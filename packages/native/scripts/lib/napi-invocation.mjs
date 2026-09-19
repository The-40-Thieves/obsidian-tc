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

// napi build's own long/short forms (`napi build --help`, @napi-rs/cli 3.7.2): "--watch,-w  watch
// the crate changes and build continuously with `cargo-watch`". Nothing in this repo drives it
// through `bun run build`/`build:debug` (checked: no `--watch`/`-w` reference to napi build in
// package.json, .github, docs, or the justfile) -- and this wrapper's staging + promote-once model
// is fundamentally incompatible with a long-running watch process: build.mjs waits synchronously
// for `napi build` to exit before promoting, so under `--watch` it would promote nothing until the
// watcher is killed, and interrupting it exits before any copy ever runs. Reject rather than
// silently misbehave; see buildNapiBuildInvocation below and README.md's "Windows: locked .node"
// section for the pointer to running `napi build --watch` directly instead.
const WATCH_FLAGS = new Set(["--watch", "-w"]);

export const WATCH_NOT_SUPPORTED_MESSAGE =
  "native build: --watch is not supported through this wrapper -- it stages a build and " +
  "promotes it ONCE, after napi build exits, so a long-running watcher never gets promoted and " +
  "interrupting it skips the copy entirely. Run `napi build --watch` (or " +
  "`./node_modules/.bin/napi build --watch`) directly from packages/native instead.";

export class WatchNotSupportedError extends Error {
  constructor() {
    super(WATCH_NOT_SUPPORTED_MESSAGE);
  }
}

/** True when `extraArgs` (the argv this wrapper forwards to `napi build`) requests watch mode. */
export function hasWatchFlag(extraArgs) {
  return extraArgs.some((arg) => WATCH_FLAGS.has(arg));
}

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
  if (hasWatchFlag(extraArgs)) {
    throw new WatchNotSupportedError();
  }
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
