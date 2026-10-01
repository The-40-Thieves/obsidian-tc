#!/usr/bin/env node
// Run a command with a private temp root and FAIL if it leaves anything in it.
//
//   node scripts/with-tmp-guard.mjs <command> [args...]
//
// The `node --test scripts/*.test.mjs` suite (`bun run test:scripts`) is not vitest, so the
// vitest globalSetup gate (packages/server/test/tmp-guard.ts) cannot see it, and its fixtures leaked
// the same way (check-*, where-*, verify-* directories in /tmp). This is the same idea for any
// command: TMPDIR (TMP/TEMP on Windows) points at a fresh directory only this run writes to, so a
// leftover is attributable to this run even on a shared host, whatever os.tmpdir() is on the OS.
//
// The root is deleted before the report is printed, so a leak costs a failed run, not disk.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Entries a command may leave behind. Each needs a reason; empty on purpose. */
export const ALLOWED_LEFTOVERS = [];

export function listLeftovers(root, allow = ALLOWED_LEFTOVERS) {
  return readdirSync(root)
    .filter((name) => !allow.some((a) => a.entry.test(name)))
    .sort();
}

function describeEntry(root, name) {
  let bytes = 0;
  const stack = [join(root, name)];
  while (stack.length > 0) {
    const cur = stack.pop();
    try {
      const st = statSync(cur);
      if (st.isDirectory()) for (const n of readdirSync(cur)) stack.push(join(cur, n));
      else bytes += st.size;
    } catch {
      // vanished or unreadable: count what is visible
    }
  }
  return `${name}  (${bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.ceil(bytes / 1024)} KB`})`;
}

/** Spawn `argv` under a private temp root. Resolves to `{ code, leaks }`; the root is gone. */
export async function runWithTmpGuard(argv, { baseDir = tmpdir(), env = process.env } = {}) {
  const root = mkdtempSync(join(realpathSync(baseDir), "obtc-guard-"));
  const childEnv = { ...env, TMPDIR: root };
  if (process.platform === "win32") {
    childEnv.TMP = root;
    childEnv.TEMP = root;
  }
  const code = await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env: childEnv });
    child.on("error", (e) => {
      console.error(`[tmp-guard] could not start ${argv[0]}: ${e.message}`);
      resolve(127);
    });
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  const leaks = listLeftovers(root).map((name) => describeEntry(root, name));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { code, leaks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("usage: node scripts/with-tmp-guard.mjs <command> [args...]");
    process.exit(2);
  }
  const { code, leaks } = await runWithTmpGuard(argv);
  if (leaks.length > 0) {
    console.error(
      `[tmp-guard] ${leaks.length} temp entr${leaks.length === 1 ? "y" : "ies"} outlived the command (removed):\n` +
        leaks.map((l) => `  ${l}`).join("\n") +
        "\nA fixture that mkdtemps must remove its directory in a finally/afterEach/after hook, even when an assertion throws.",
    );
  }
  process.exit(code !== 0 ? code : leaks.length > 0 ? 1 : 0);
}
