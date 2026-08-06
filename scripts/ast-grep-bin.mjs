// Resolve the ast-grep binary WITHOUT depending on it being on PATH.
//
// WHY THIS EXISTS: `where-symbol.mjs` underwrites every absence claim in this repo —
// `verify-ticket-premise` cites its exit 1 as what makes "this symbol does not exist" checkable.
// It shelled out to a bare `ast-grep`, which was declared in NO package.json. It therefore worked
// on machines that happened to have it (this one, via mise) and threw on machines that did not.
// That is worse than failing everywhere: the failure is machine-dependent, so it looks like a
// local environment quirk rather than a missing dependency, and the fallback is `rg` — the exact
// PROSE-ONLY blind spot the tool was built to remove.
//
// `@ast-grep/cli` is now an exact devDependency pinned to 0.45.0, matching ci-quality.yml's
// checksummed binary. This module makes the scripts actually USE it.
//
// Two platform traps are handled deliberately:
//
//  1. `node_modules/.bin/ast-grep` is NOT safe to exec on Windows. npm/bun materialise it as
//     `ast-grep.cmd`, and `execFileSync` on a `.cmd` throws EINVAL on current Node (the
//     CVE-2024-27980 mitigation). `shell: true` would fix that and break something worse — the
//     inline-rule argument is JSON, and Windows shell quoting mangles it. So we never touch the
//     `.bin` shim; we resolve the package's own entry point instead.
//
//  2. That entry point is EITHER a `#!/usr/bin/env node` shim OR the native binary, depending on
//     whether `postinstall` ran. This repo installs with `--ignore-scripts` in CI, so the shim is
//     the normal case here — it resolves the platform binary at runtime and prints a one-line
//     notice to stderr about the per-invocation overhead. We sniff the first two bytes and invoke
//     the shim through `process.execPath` rather than executing it directly, which works whether
//     or not postinstall ever runs. Enabling postinstall would remove the overhead at the cost of
//     running an install script, which is a posture change this module deliberately does not make.
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ENTRY = join(ROOT, "node_modules", "@ast-grep", "cli", "ast-grep");

/** True when the file begins `#!` — i.e. a script, not a native executable. */
function isScript(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(2);
    return readSync(fd, buf, 0, 2, 0) === 2 && buf.toString("latin1") === "#!";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * `{ cmd, prefix }` for spawning ast-grep. Call as
 * `execFileSync(cmd, [...prefix, ...yourArgs])`.
 *
 * Prefers the declared devDependency; falls back to PATH so a machine with ast-grep installed
 * some other way (mise, homebrew, the CI zip) still works. The fallback is the reason this is not
 * simply a hard require: CI installs the pinned binary itself and puts it on PATH.
 */
export function astGrep() {
  if (existsSync(PKG_ENTRY)) {
    return isScript(PKG_ENTRY)
      ? { cmd: process.execPath, prefix: [PKG_ENTRY] }
      : { cmd: PKG_ENTRY, prefix: [] };
  }
  return { cmd: "ast-grep", prefix: [] };
}
