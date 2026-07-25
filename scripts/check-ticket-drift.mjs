#!/usr/bin/env node
// THE-540: flag OPEN tickets whose id already appears in the code. This repo cites ticket ids in
// comments as a matter of course, so the code frequently knows things the tracker does not.
//
// THE-426 is the origin story: it sat open for eight days after being fully implemented, while
// scripts/release.mjs:48 carried the literal comment "tsc gate (THE-426)". The implementation knew
// its own ticket number; nobody told Linear. Since then the same check — run by hand — closed
// THE-567, THE-568, THE-505, THE-535 and rescoped THE-508, all already shipped while sitting in Todo.
//
// It reports CANDIDATES FOR REVIEW, never closures. A reference is not completion: THE-424 is cited
// by code that is explicitly NOT wired, and THE-539 is referenced by design docs while iceboxed on
// purpose. The script surfaces the question; a human answers it.
//
// Two deliberate design choices, both about keeping the signal worth reading:
//
//   1. NOT a per-PR gate. Citing an open ticket while working on it is normal and correct, so a gate
//      would fire on every good PR. Weekly + dispatch, like check-release-lag.mjs.
//   2. Only NOT-STARTED tickets can fail the run. An "In Progress" ticket being referenced is
//      exactly what you expect. Code existing for something nobody has started is the actual smell.
//
// References are ranked by where they live, because they mean different things:
//   src / workflow  -> STRONG. Shipped code or shipped CI cites this ticket.
//   scripts / test  -> STRONG. Same: it is executable and it is on main.
//   docs            -> WEAK. Design notes legitimately discuss unstarted and iceboxed work.
// Weak-only references are reported for context and never fail the run.
//
// Shell-free: git is invoked via execFileSync with an argument array, never through a shell.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TICKET_RE = /\bTHE-(\d{1,5})\b/g;

/** Where a reference lives. Order matters: a test under packages/ must classify as `test`, not `src`.
 *  Which of these count as strong evidence is declared once, in STRONG_AREAS below. */
function areaOf(path) {
  if (path.startsWith(".github/")) return "workflow";
  if (/(^|\/)test\//.test(path) || path.endsWith(".test.ts")) return "test";
  if (path.startsWith("scripts/")) return "scripts";
  if (path.startsWith("docs/")) return "docs";
  if (path.startsWith("packages/")) return "src";
  return "other";
}

// Tracked files only, so an untracked scratch file cannot influence the report. Explicitly NOT a
// filesystem walk: generated and ignored output has no business voting on ticket state.
const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean)
  .filter((f) => /\.(ts|tsx|mjs|js|cjs|json|ya?ml|md|sql|rs|py|toml)$/.test(f))
  // The generated embedded-migrations module inlines every .sql verbatim, so it re-reports every
  // ticket id mentioned in a migration comment. Real references, already counted at their source.
  .filter((f) => f !== "packages/server/src/db/migrations-embedded.ts");

if (files.length === 0) {
  console.error(
    "check-ticket-drift: git ls-files returned nothing — refusing to report over an empty set",
  );
  process.exit(1);
}

/** id -> Map<area, Set<path>> */
const refs = new Map();
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable; nothing to match
  }
  const seen = new Set();
  for (const m of text.matchAll(TICKET_RE)) {
    const id = `THE-${m[1]}`;
    if (seen.has(id)) continue; // one hit per file per ticket keeps the report readable
    seen.add(id);
    const area = areaOf(file);
    if (!refs.has(id)) refs.set(id, new Map());
    const byArea = refs.get(id);
    if (!byArea.has(area)) byArea.set(area, new Set());
    byArea.get(area).add(file);
  }
}

const ticketsArg = process.argv.indexOf("--tickets");
if (ticketsArg === -1) {
  // Inventory mode: no ticket list, so just report what the code cites. Useful on its own, and it
  // means the script is runnable with no credentials at all.
  const ids = [...refs.keys()].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  console.log(
    `check-ticket-drift: ${ids.length} distinct ticket ids referenced across ${files.length} tracked files.`,
  );
  console.log(
    'Pass --tickets <file> (JSON: [{"id":"THE-1","state":"Todo"}]) to cross-check against open tickets.',
  );
  console.log(ids.join(" "));
  process.exit(0);
}

const ticketsFile = process.argv[ticketsArg + 1];
if (!ticketsFile) {
  console.error("check-ticket-drift: --tickets requires a path");
  process.exit(2);
}
const tickets = JSON.parse(readFileSync(ticketsFile, "utf8"));
if (!Array.isArray(tickets) || tickets.length === 0) {
  console.error(
    "check-ticket-drift: ticket list is empty or not an array — refusing to report 'no drift' over nothing",
  );
  process.exit(1);
}

// "Not started" is the failing condition. Anything already in flight is expected to be cited.
const NOT_STARTED = new Set(["backlog", "todo", "triage", "unstarted"]);

/** Areas whose references are strong evidence — kept in one place, used by areaOf() and below. */
const STRONG_AREAS = new Set(["src", "workflow", "scripts", "test"]);

const strong = [];
const weak = [];
for (const t of tickets) {
  const byArea = refs.get(t.id);
  if (!byArea) continue;
  const row = {
    id: t.id,
    state: t.state ?? "?",
    title: t.title ?? "",
    notStarted: NOT_STARTED.has(String(t.state ?? "").toLowerCase()),
    areas: [...byArea.entries()].map(([area, paths]) => [area, [...paths].sort()]),
  };
  const hasStrong = row.areas.some(([area]) => STRONG_AREAS.has(area));
  (hasStrong ? strong : weak).push(row);
}

function report(rows, heading) {
  if (rows.length === 0) return;
  console.log(`\n${heading}`);
  for (const r of rows.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))) {
    const flag = r.notStarted ? "NOT STARTED" : r.state;
    console.log(`  ${r.id}  [${flag}]  ${r.title}`.trimEnd());
    for (const [area, paths] of r.areas) {
      const shown = paths.slice(0, 3).join(", ");
      const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
      console.log(`      ${area}: ${shown}${more}`);
    }
  }
}

console.log(
  `check-ticket-drift: ${tickets.length} open tickets vs ${refs.size} ids referenced across ${files.length} tracked files.`,
);
report(strong, "Referenced by CODE, CI, scripts or tests — verify against main before scheduling:");
report(
  weak,
  "Referenced only by docs (weak signal — design notes discuss unstarted work legitimately):",
);

const failing = strong.filter((r) => r.notStarted);
if (failing.length === 0) {
  console.log("\ncheck-ticket-drift: no not-started ticket is referenced by executable content.");
  process.exit(0);
}

console.log(
  `\ncheck-ticket-drift: ${failing.length} NOT-STARTED ticket(s) are referenced by executable content: ${failing
    .map((r) => r.id)
    .join(", ")}`,
);
console.log(
  "Each is either already (partly) done, or its code comment is aspirational. Verify, then",
);
console.log(
  "close it or annotate why it is legitimately open — see THE-540 for the triage convention.",
);
// Advisory by default so this can be run freely; the scheduled workflow passes --strict to go red.
process.exit(process.argv.includes("--strict") ? 1 : 0);
