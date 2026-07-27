#!/usr/bin/env node
// Fail when the same symbol NAME is declared by two different modules, unless the pair is recorded
// in the baseline below with a reason.
//
// WHY THIS EXISTS
// The duplications that have actually cost time in this repo were invisible to every test, because
// the copies AGREED:
//   - DEFAULT_MEMORY_FOLDER existed three ways (tools/m5, config.schema's own .default("memory"),
//     and a fourth nearly added in cli/commands/forget.ts) — on a path that resolves which folder
//     `forget --erase` destroys.
//   - MAX_RESOURCE_BYTES and maxResponseBytes held the same number, but only one was wired to
//     config, so lowering the configured ceiling silently applied to tools and not resources.
//   - paginate<T> was declared twice, byte-identical (THE-516).
// A behavioural test cannot see any of these. A name-level scan can.
//
// WHAT IT IS NOT
// This is NOT "deduplicate every repeated shape". Three of the four baseline entries below are
// byte-identical type declarations in modules that do NOT import each other — merging them would
// create coupling between independent layers to save four lines, which is the documented failure
// mode of DRY (an abstraction more expensive than the duplication it removes). They are recorded,
// not fixed, deliberately.
//
// The gate's real job is the FIFTH one: a new duplicate name must be a decision someone wrote down,
// not an accident nobody noticed.
//
// Declarations only. `export { X } from "./y"` is a re-export of one definition, not a second.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["packages/server/src", "packages/shared/src"];

// Baseline: name -> reason it is allowed to be declared more than once. Entries may be REMOVED
// (fix the duplication) but adding one requires justifying it here, in review.
const BASELINE = {
  FetchFn:
    "`type FetchFn = typeof fetch` in embeddings/http.ts and gateway/client.ts. A one-line alias " +
    "of a global with no semantic content — sharing it would couple the embeddings client to the " +
    "gateway client for no gain.",
  RerankHit:
    "`{index, relevanceScore}` in gateway/client.ts and search/rerank.ts. Byte-identical, but the " +
    "two modules do not import each other; merging creates a search -> gateway edge to save four " +
    "lines. Coincidental shape, not a shared fact.",
  IndexedChunk:
    "`{id, path, content, embedding}` in plane/jobs/contradiction.ts and search/indexer.ts. Same " +
    "reasoning as RerankHit — independent modules, no existing edge between them.",
  Job:
    "plane/plane.ts's Job is `{name, run()}` (a runnable); scheduler/job-queue.ts's Job is a " +
    "durable queue row `{id, type, class, state, attempt, ...}`. Genuinely different concepts " +
    "that share a name. Renaming one would be clearer, but that is a rename, not a de-duplication.",
};

const DECL =
  /^export\s+(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

// Swallow a missing root so the FLOOR below reports it, not a readdirSync stack trace. Both fail,
// but only one says why — and "the scan root moved" is the failure this gate most needs to name,
// since it is the one that would otherwise look like a clean codebase.
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = SCAN.flatMap((d) => walk(join(ROOT, d)));

// Non-empty floor. A broken walk root must fail loudly, not report a clean scan — an empty scan and
// a clean codebase are indistinguishable in the exit code otherwise.
if (files.length < 100) {
  console.error(
    `duplicate-exports: scanned only ${files.length} files, expected >100.\n` +
      "The directory walk is broken, not the codebase. Refusing to report success.",
  );
  process.exit(1);
}

const owners = new Map();
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join("/"); // POSIX-normalize: Windows CI compares these
  for (const m of readFileSync(f, "utf8").matchAll(DECL)) {
    if (!owners.has(m[1])) owners.set(m[1], new Set());
    owners.get(m[1]).add(rel);
  }
}

const dupes = [...owners].filter(([, v]) => v.size > 1);
const unexpected = dupes.filter(([name]) => !(name in BASELINE));
const stale = Object.keys(BASELINE).filter((n) => !owners.get(n) || owners.get(n).size < 2);

if (stale.length > 0) {
  console.error(
    `duplicate-exports: ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} ` +
      `no longer duplicated: ${stale.join(", ")}\n` +
      "The duplication was fixed — remove the entry so the baseline only ever shrinks.",
  );
  process.exit(1);
}

if (unexpected.length > 0) {
  console.error(
    `duplicate-exports: ${unexpected.length} name(s) declared in more than one module:\n`,
  );
  for (const [name, where] of unexpected) {
    console.error(
      `  ${name}\n${[...where]
        .sort()
        .map((w) => `      ${w}`)
        .join("\n")}`,
    );
  }
  console.error(
    "\nTwo copies of one FACT diverge silently — no test sees it while they agree.\n" +
      "Two modules that coincidentally share a shape are fine; coupling them to merge a few\n" +
      "lines is usually worse than the duplication.\n\n" +
      "Fix it, or add the name to BASELINE in scripts/check-duplicate-exports.mjs with the reason.",
  );
  process.exit(1);
}

console.error(
  `duplicate-exports: ${files.length} files, ${owners.size} exported names, ` +
    `${dupes.length} duplicated (all ${dupes.length} baselined).`,
);
