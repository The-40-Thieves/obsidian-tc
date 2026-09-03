#!/usr/bin/env node
/**
 * link-plugin — symlinks packages/plugin/dist/ into a vault's
 * `.obsidian/plugins/tc-bridge/` directory (plugin id `tc-bridge`, renamed from `obsidian-tc`
 * THE-943), the manual step CONTRIBUTING.md's "Running the plugin in Obsidian" section otherwise
 * has a contributor build by hand every time ("Symlink packages/plugin/dist/ into your test
 * vault's .obsidian/plugins/tc-bridge/ directory").
 *
 * Builds the plugin first (`bun run build` in packages/plugin) if dist/main.js is missing.
 * Idempotent: re-running replaces a link this script made; a real, non-symlink directory already
 * at the target is left alone and reported, never deleted out from under someone's data.
 *
 * Windows: `build-test (windows-latest)` is a required CI check, so Windows contributors are
 * explicitly in scope. A plain directory symlink there needs Developer Mode or an elevated
 * shell; a directory JUNCTION does not. `fs.symlinkSync(..., "junction")` on win32 creates one —
 * Node reports it back via `lstat().isSymbolicLink()` the same as a POSIX symlink, so the
 * idempotency check below needs no platform branch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pluginDir = join(root, "packages", "plugin");
const distDir = join(pluginDir, "dist");

const vaultArg = process.argv[2];
if (!vaultArg) {
  console.error("usage: node scripts/link-plugin.mjs <path-to-vault>");
  console.error("       (or: just link-plugin <path-to-vault>)");
  process.exit(1);
}

const vault = resolve(vaultArg);
if (!existsSync(vault)) {
  console.error(`link-plugin: vault directory does not exist: ${vault}`);
  process.exit(1);
}

if (!existsSync(join(distDir, "main.js"))) {
  console.log("link-plugin: packages/plugin/dist/ is missing — building it first…");
  execFileSync("bun", ["run", "build"], { cwd: pluginDir, stdio: "inherit" });
}

const pluginsDir = join(vault, ".obsidian", "plugins");
mkdirSync(pluginsDir, { recursive: true });
const target = join(pluginsDir, "tc-bridge");

if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink()) {
    rmSync(target, { force: true });
  } else {
    console.error(
      `link-plugin: ${target} already exists and is a real directory, not a link this script ` +
        "made. Remove it by hand if you want it replaced (rm -rf on POSIX, rmdir /s on Windows).",
    );
    process.exit(1);
  }
}

symlinkSync(distDir, target, process.platform === "win32" ? "junction" : "dir");
console.log(`link-plugin: linked ${target} -> ${distDir}`);
console.log(
  'Enable "TC Bridge" under Community Plugins, then restart Obsidian on manifest changes.',
);
