#!/usr/bin/env node
/**
 * doctor — contributor TOOLCHAIN diagnostic. Compares what `bun`/`node`/`python3`/`rustc`
 * actually resolve to on THIS PATH against mise.toml's pins (and packages/native/rust-toolchain.toml
 * for Rust, which mise.toml itself does not pin — see that file's header for why it lives apart).
 *
 * This is NOT the `obsidian-tc doctor` CLI subcommand (packages/server/src/cli.ts) — that one
 * diagnoses a RUNNING server's own runtime/config. This one answers a question one layer earlier:
 * is your machine even set up to build and test the repo.
 *
 * `mise install` already does most of the enforcement — mise refuses to resolve a pinned tool to
 * anything but the pinned version. This exists for what `mise install` cannot catch on its own:
 * a shell session whose PATH predates a mise change (a stale mise shim can silently point at an
 * old version), or a contributor not using mise at all. Read-only: never installs or modifies
 * anything, just reports.
 *
 * Bun and Node are load-bearing (CONTRIBUTING.md lists both as "Required") — a mismatch there
 * exits non-zero. Python and Rust are each optional for parts of this repo (CONTRIBUTING.md:
 * Rust is skippable if you only touch server/plugin code) — reported the same way, but a mismatch
 * there warns instead of failing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function readPin(text, tool) {
  return new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, "m").exec(text)?.[1] ?? null;
}

function versionOf(cmd, args, extract) {
  let out;
  try {
    out = execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  return extract(out);
}

const miseToml = readFileSync(join(root, "mise.toml"), "utf8");
const rustToolchainToml = readFileSync(join(root, "packages/native/rust-toolchain.toml"), "utf8");

const checks = [
  {
    name: "bun",
    required: true,
    pinned: readPin(miseToml, "bun"),
    found: versionOf("bun", ["--version"], (s) => s),
  },
  {
    name: "node",
    required: true,
    pinned: readPin(miseToml, "node"),
    found: versionOf("node", ["--version"], (s) => s.replace(/^v/, "")),
  },
  {
    name: "python",
    required: false,
    pinned: readPin(miseToml, "python"),
    found: versionOf("python3", ["--version"], (s) => s.replace(/^Python\s+/, "")),
    // mise.toml pins the minor only ("3.11") — compare on the minor, not the patch.
    compareMinorOnly: true,
  },
  {
    name: "rust",
    required: false,
    pinned: /channel\s*=\s*"([^"]+)"/.exec(rustToolchainToml)?.[1] ?? null,
    found: versionOf("rustc", ["--version"], (s) => s.match(/rustc (\S+)/)?.[1] ?? null),
  },
];

console.log("doctor — contributor toolchain vs. this repo's pins\n");

let hardFailures = 0;
let softMismatches = 0;
for (const c of checks) {
  const label = c.name.padEnd(8);
  if (!c.found) {
    const sev = c.required ? "MISSING " : "missing ";
    console.log(`  ${sev} ${label} expected ${c.pinned ?? "?"} — not found on PATH`);
    if (c.required) hardFailures++;
    else softMismatches++;
    continue;
  }
  const found = c.compareMinorOnly ? c.found.split(".").slice(0, 2).join(".") : c.found;
  const ok = found === c.pinned;
  console.log(`  ${ok ? "ok      " : "MISMATCH"} ${label} expected ${c.pinned}, found ${c.found}`);
  if (!ok) {
    if (c.required) hardFailures++;
    else softMismatches++;
  }
}

console.log();
if (hardFailures > 0) {
  console.log(
    `doctor: ${hardFailures} required mismatch(es)${softMismatches ? `, ${softMismatches} optional` : ""}. ` +
      "Run `mise install` from the repo root — it resolves every pinned tool onto PATH via " +
      "shims. If you are not using mise, install the versions above by hand.",
  );
  process.exit(1);
}
if (softMismatches > 0) {
  console.log(
    `doctor: bun/node match; ${softMismatches} optional tool(s) differ or are missing — fine if ` +
      "you are not touching the native module or the Python services.",
  );
  process.exit(0);
}
console.log("doctor: toolchain matches mise.toml. You are good to go.");
