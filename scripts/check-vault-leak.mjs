#!/usr/bin/env node
// Fail the build if private vault data is tracked in this repository.
//
// WHY THIS EXISTS: for two weeks this public repo served a map of a personal Obsidian vault — 227 real
// note paths, 136 plain-English descriptions of their contents, and (via a committed SQLite index) the
// FULL TEXT of 100 notes, including health records. Six code reviews missed it, because every one of them
// audited the DIFF and none audited the REPO. A grep would have found it in a second. This is that grep.
//
// TWO LAYERS, because they answer different questions:
//
//   STRUCTURAL (default, runs in CI, needs no vault) — whole artifacts that are never legitimate: a
//   committed index, a golden set, the operator's vault path. Cheap and deterministic on exactly the
//   things that burned us.
//
//   DEEP (--vault <path>, runs locally where the vault exists) — CONTENT leaks: a real note title pasted
//   into a test fixture. CI structurally cannot do this: "02-projects/AI OS Futures.md" (a real note) and
//   "02-projects/foo.md" (invented) are indistinguishable to a regex. Only the vault knows. And the
//   machine holding the vault is the machine where such a leak originates, so that is where it runs.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const vaultIdx = args.indexOf("--vault");
const VAULT = vaultIdx !== -1 ? args[vaultIdx + 1] : null;

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const failures = [];
const fail = (file, line, rule, detail) => failures.push({ file, line, rule, detail });

const SELF = "scripts/check-vault-leak.mjs";
const isText = (f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|node|db|wasm|pdf)$/i.test(f);

// ── STRUCTURAL ──────────────────────────────────────────────────────────────────────────────────────
for (const f of tracked) {
  // A committed index is never legitimate. This is the artifact that leaked 100 notes in full.
  if (f.startsWith(".obsidian-tc/")) {
    fail(f, 0, "committed-index", "a vault index must never be tracked");
  }
  if (/\.(db|sqlite3?)(-wal|-shm)?$/.test(f)) {
    fail(f, 0, "database", "database files must never be tracked");
  }
  // A golden set keys queries to real note paths. Only the synthetic example may be committed.
  if (/golden-set.*\.ya?ml$/.test(f) && !f.endsWith(".example.yaml")) {
    fail(f, 0, "golden-set", "golden sets contain real note paths; keep them gitignored");
  }
}

for (const f of tracked) {
  if (!isText(f) || f === SELF) continue;
  let body;
  try {
    body = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  body.split("\n").forEach((line, i) => {
    // The operator's real vault location. Docs and tests must use a placeholder.
    if (/Obsidian[/\\]Second Brain|["'`][A-Z]:[/\\]Obsidian/.test(line)) {
      fail(f, i + 1, "vault-path", "use a placeholder, not the real vault location");
    }
    // Golden-set structure in a DATA file. Deliberately NOT in source: a `seed_paths` field in a .ts file
    // is a schema declaration — the code that READS a golden set — which is exactly what this repo should
    // contain. The data is the problem, never the schema. A first draft of this rule conflated them and
    // flagged 24 legitimate type declarations, which is how a guard teaches people to ignore it.
    if (
      /\.(ya?ml|json)$/.test(f) &&
      !f.endsWith(".example.yaml") &&
      /^\s*(seed_paths|target_paths|bridge_paths)\s*:/.test(line)
    ) {
      fail(f, i + 1, "golden-set-shape", "golden-set data keyed to real notes");
    }
  });
}

// ── DEEP (needs the vault) ──────────────────────────────────────────────────────────────────────────
// Every "NN-folder/....md" string in tracked content, checked against the notes that ACTUALLY exist.
// An exact match is a real note title sitting in a public repo. An invented one is fine.
if (VAULT) {
  const notes = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) notes.add(relative(VAULT, p).split(sep).join("/").toLowerCase());
    }
  };
  walk(VAULT);

  const PATH_RE = /[0-9]{2}-[a-z-]+(?:\/[^"'`\n\\/]+)*\.md/gi;
  for (const f of tracked) {
    if (!isText(f) || f === SELF) continue;
    let body;
    try {
      body = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    body.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(PATH_RE)) {
        if (notes.has(m[0].toLowerCase())) {
          fail(f, i + 1, "REAL-NOTE", `"${m[0]}" is an actual note in the vault`);
        }
      }
    });
  }
}

// ── REPORT ──────────────────────────────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  const mode = VAULT ? "structural + deep" : "structural only";
  console.log(`vault-leak: clean (${tracked.length} tracked files, ${mode})`);
  if (!VAULT) {
    console.log("  deep check skipped — pass --vault <path> to compare against real note titles");
  }
  process.exit(0);
}

console.error(
  `vault-leak: ${failures.length} PROBLEM(S) — private vault data must not be tracked\n`,
);
for (const x of failures) {
  console.error(`  [${x.rule}] ${x.file}${x.line ? `:${x.line}` : ""}`);
  console.error(`      ${x.detail}`);
}
console.error(
  "\nIf a hit is a synthetic fixture, RENAME it — do not add an exception. The whole point is",
);
console.error(
  "that no real note title ever appears in a public repository, not that we curate a list of",
);
console.error("the ones we tolerate.");
process.exit(1);
