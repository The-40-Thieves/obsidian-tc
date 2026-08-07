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
// ---------------------------------------------------------------------------------------------
// DIRECTION 2, added 2026-08-07: a CLOSED ticket cited as a LIVE DEPENDENCY.
//
// The check above walks the OPEN ticket list, so a closed ticket can never appear in its output —
// the blindness was structural, not a bug. Measured on this repo the day it was added: 415 distinct
// ids referenced across 1,307 tracked files, of which 21 were open (checked) and at least 238 were
// closed or cancelled (never checked). An 11x asymmetry, in the direction that had already caused
// real damage:
//
//   * `experiential.captureContent` and `sessions.traceContent` were both default-off "until the
//     THE-238 poisoning defense red-team". THE-238 closed 2026-07-11 and never contained a
//     red-team — the comment named an event no ticket has ever owned. Two config defaults, and
//     `obsidian-tc rerun` inert in production, waiting on it.
//   * `agent_episodes.summary` is documented "filled at consolidation (THE-222)". THE-222 closed
//     2026-07-12 having shipped `reflect` and never touched that column.
//
// The distinction that makes this checkable rather than noisy: PROVENANCE vs DEPENDENCY.
// "THE-228 — the agent_episodes capture bus" is provenance. It is correct, permanent, and should
// never be flagged. "off until THE-238 lands" is a dependency — a claim about the future, which a
// closed ticket can no longer satisfy. Only dependency-phrased references to closed tickets fail.
//
// The durable fix this encodes: cite an ARTIFACT or a CONDITION, not a ticket. "until the THE-238
// red-team" rots the moment THE-238 closes; "while args_json is NULL on every row" is checkable in
// SQL and cannot.
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

/** Words that turn a citation into a FORWARD DEPENDENCY. Deliberately narrow: every one of these
 *  asserts the ticket has not happened yet, which is exactly the claim a closed ticket falsifies.
 *
 *  `pending` is NOT here as a bare word, and that is load-bearing: `eligibility='pending'` is a
 *  literal enum value all over the experiential code, so a bare \bpending\b matched provenance
 *  comments in reflect.ts on the first run. Requiring a determiner after it ("pending the red-team")
 *  keeps the English sense and drops the SQL one.
 *
 *  `once` is not here either, and that was measured rather than assumed. Across four full-board runs
 *  it produced nearly every false positive — "normalized ONCE here", "retry ONCE", "resolved ONCE at
 *  startup", "the cap has been raised ONCE" — against exactly one true finding, since rewritten
 *  anyway. English overwhelmingly means "one time", not "at the moment when". A term with that
 *  precision is not worth an allowlist entry per occurrence. */
const DEP_WORDS =
  /\b(?:until|awaiting|blocked on|gated on|waits? on|waiting on|filled at|deferred to|left to|after)\b|\bpending\s+(?:the|a|an|its)\b/gi;

/** How far a dependency word may sit from the ticket id and still be ABOUT it. Proximity is what
 *  separates "off until the THE-238 defence" from "the glob is normalized ONCE here; the PATH is
 *  still normalized per call ... (THE-272)" — same word, 110 characters and one topic apart.
 *
 *  Calibrated by running the full board rather than a sample: at 10 tickets the loose version looked
 *  clean, and only across 250 closed ones did `once` and `after` show up as the noise they are.
 *  Every real finding on this repo sits inside ~25 characters, so 30 is the whole budget — 70 was
 *  tried first and let a third of the coincidences straight back in. A sentence break inside the gap
 *  disqualifies it regardless of distance. */
const DEP_MAX_GAP = 30;

/** A dependency word in the PAST tense is history, not a promise: "that cap has already been raised
 *  once (THE-610)", "no coverage until THE-583 came to replace it", "`tracesDays` was removed once
 *  for exactly that reason". All true, all permanent, none a claim the ticket still owes anything.
 *
 *  Measured, not assumed: this took the full-board residue from 12 candidates to 9. The remaining
 *  nine are in DEP_ALLOW — regex does not finish this job, and pretending otherwise is how a gate
 *  ends up quietly wrong rather than loudly incomplete.
 *
 *  A real dependency reads present/future — "off until the defence LANDS", "filled AT consolidation",
 *  "honest-empty until the evaluator STAMPS rows" — and none of those trip this. */
const PAST_TENSE =
  /\b(?:was|were|had|has been|have been|came|landed|shipped|already|used to|previously|no longer)\b/i;

/** Areas whose references are strong evidence — declared here because both areaOf()'s callers and
 *  the dependency scan need it. */
const STRONG_AREAS = new Set(["src", "workflow", "scripts", "test"]);

/** This file documents the failure mode by QUOTING the stale phrases it hunts for, so it matches
 *  itself on every run. Excluded deliberately: a check that reports its own documentation as a
 *  finding trains people to ignore it. */
const SELF = "scripts/check-ticket-drift.mjs";

/** Shipped migrations are IMMUTABLE — checksum-pinned, and editing one is a hard startup error on
 *  every existing deployment. `20260711_002_agent_episodes.sql` genuinely does say "gist, filled at
 *  consolidation (THE-222)" about a ticket that closed without building it, and that sentence can
 *  never be corrected in place. Exempted so the check can go green, because a gate that is
 *  permanently red for an unfixable reason gets muted and then covers nothing.
 *  The correction belongs in the code that READS the column, which is not exempt. */
const IMMUTABLE = /^packages\/server\/src\/migrations\/.*\.sql$/;

/** Triaged 2026-08-07 over the full board — THE-540's own Done-when ("each flagged ticket either
 *  closed, or annotated explaining why it is legitimately open; that first triage is the real
 *  deliverable"). Every entry is a dependency word governing something OTHER than the ticket beside
 *  it, verified by reading the comment. Keyed on file+ticket rather than ticket alone, so the same
 *  id in a NEW file still fires.
 *
 *  Add to this only after reading the comment and concluding the citation is provenance. Rewriting
 *  the sentence is always the better fix; this exists so nine coincidences cannot hold the gate red
 *  and get it muted. */
const DEP_ALLOW = new Map([
  // "keeps the experiential handle closed AFTER BOOT PROVISIONING" — a lifecycle phrase.
  ["packages/shared/src/config/retrieval.schema.ts::THE-230", "governs boot provisioning"],
  // "Runs AFTER applyVaultAcl" — describes ACL resolution ORDER, not a wait on the ticket.
  ["packages/server/src/mcp/registry/input-binding.ts::THE-267", "governs dispatch ordering"],
  // "throttle every pass AFTER THE FIRST" — counts scheduler passes.
  ["packages/server/src/runtime/plane-wiring.ts::THE-296", "governs pass count"],
  // "AFTER a same-dimension model swap" — names the test scenario.
  ["packages/server/test/model-swap-reembed.test.ts::THE-460", "governs the swap scenario"],
  // "under 2026-07-28 AFTER THE SDK MIGRATES" — a real forward dependency, on the upstream SDK
  // rather than on this ticket. The ticket id next to it is provenance for the dual-era support.
  ["packages/server/src/otel/propagation.ts::THE-583", "governs the upstream SDK, not the ticket"],
  // "flaked ... even AFTER a recalibration" — history of a fix that already happened.
  ["packages/server/eval/perf/run.ts::THE-584", "past-tense narrative"],
  // "still flaked ... AFTER landing in the unit suite" — same shape.
  ["packages/server/eval/perf/spearman.ts::THE-594", "past-tense narrative"],
  // A narrative about prose that HAD drifted and was corrected.
  ["packages/server/scripts/docgen/facts-check.ts::THE-599", "past-tense narrative"],
  // NOTE: two THE-610 entries lived here ("the cap has been raised once", "`tracesDays` was removed
  // once") and were deleted when `once` came out of DEP_WORDS. Every surviving entry is `after` in
  // its temporal sense. Re-derive this list by emptying the Map and re-running rather than trusting
  // it — an allowlist entry that outlives its cause is the same defect this script exists to catch.
]);

/** DIRECTION 1's triage, 2026-08-07. This is THE-540's own Done-when finally met: "each flagged
 *  ticket either closed, or annotated explaining why it is legitimately open."
 *
 *  The first real dispatch flagged 18. Exactly one was a true positive — THE-748, whose own banner
 *  read SETTLED with all three of its items resolved; closed. The other 17 are below.
 *
 *  They share a shape worth naming, because it is why direction 1 fires so much on this repo: a
 *  GATED or PARKED ticket is cited by the very code that implements its dark flag, its tripwire
 *  test, or the substrate it will one day consume. The reference is evidence the decision was
 *  recorded where it is enforced — the opposite of drift. `projection.ts` saying "left to THE-424"
 *  is the system working.
 *
 *  Keyed on TICKET, not file+ticket (unlike DEP_ALLOW): the claim here is about the ticket's state,
 *  not about one comment, so a new reference in a new file does not change the answer. The cost is
 *  that an entry survives its own ticket becoming genuinely done — so RE-DERIVE this by emptying the
 *  Map and re-running, rather than trusting it. Same instruction DEP_ALLOW carries, same reason. */
const NOT_STARTED_ALLOW = new Map([
  [
    "THE-175",
    "design-only, G2-gated; cited by capture_queue/poison as the substrate it will target",
  ],
  ["THE-418", "reranker half SHIPPED v1.9.0 (colbert.ts is real); the PLAID half is scale-gated"],
  ["THE-419", "gated; cited by the perf harness that would host the measurement its gate needs"],
  [
    "THE-421",
    "cited by the CI guards and synthetic slice that shipped BECAUSE of it; residual is the fork",
  ],
  [
    "THE-424",
    "the canonical case — projection.ts says 'left to THE-424' about a deliberately unwired path",
  ],
  ["THE-468", "scale-gated; cited by the perf gate/scenarios that define its entry criterion"],
  [
    "THE-510",
    "cited by perf run + router as the CV-variance constraint; blocker refuted, work still open",
  ],
  [
    "THE-539",
    "ICEBOX by design; cited by design docs and check-table-readers, named in this file's header",
  ],
  [
    "THE-628",
    "cited by gen-multi-hop-slice as a future consumer; needs a global-query slice first",
  ],
  ["THE-633", "tables and tools SHIPPED #675; what remains is an adoption DECISION, not code"],
  ["THE-642", "item 2 shipped #673; item 1 now blocked on THE-752, which exists as of today"],
  ["THE-643", "recompute schedule shipped #576 and is producing rows; 3 items remain"],
  ["THE-644", "items 1 and 3 shipped; item 2's substance orphaned when THE-641 was cancelled"],
  ["THE-645", "items 1-3 shipped (#563/#718/#722); only in-flight index progress remains"],
  ["THE-651", "golden slice exists; what remains is a new branch in the router"],
  ["THE-673", "extractor rewrite; one derivable axis, cited by the reflect path it would replace"],
  ["THE-705", "item 2 CLOSED (class router stays dark); item 1 is a packaging gap"],
]);

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|--|#|<!--)/;

/** Collapse wrapped comment prose to one line. These comments wrap — "off until the THE-238
 *  poisoning defence \n *  lands" is one sentence to a reader and two lines to a naive grep. */
const flatten = (s) => s.replace(/[\r\n]+[ \t]*(\/\/+|\*+|--|#)?[ \t]*/g, " ").replace(/\s+/g, " ");

/** Contiguous runs of comment lines. Dependency words and ticket ids only pair when they sit in the
 *  SAME block of prose — measured on the first run: `(retrievals[0]?.retrieved_at ?? until) + …` is
 *  CODE, and pairing its `until` with a THE-717 in the comment two lines below is a false positive.
 *  Markdown is prose throughout, so every line counts there. */
function commentBlocks(text, isProse) {
  const blocks = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (isProse || COMMENT_LINE.test(line)) {
      cur ??= [];
      cur.push(line);
    } else if (cur) {
      blocks.push(cur.join("\n"));
      cur = null;
    }
  }
  if (cur) blocks.push(cur.join("\n"));
  return blocks;
}

/** Where a reference lives. Order matters: a test under packages/ must classify as `test`, not `src`.
 *  Which of these count as strong evidence is declared once, in STRONG_AREAS above. */
function areaOf(path) {
  if (path.startsWith(".github/")) return "workflow";
  // Markdown is PROSE wherever it lives. `packages/server/eval/perf/README.md` was classifying as
  // `src` purely because of its prefix, which promoted a design note to executable evidence — the
  // opposite of the docs rule three lines down. Checked before the prefix tests for that reason.
  if (path.endsWith(".md")) return "docs";
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

/** id -> { areas: Map<area, Set<path>>, dep: Map<path, evidence> } */
const refs = new Map();
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable; nothing to match
  }
  const area = areaOf(file);
  const seen = new Set();
  for (const m of text.matchAll(TICKET_RE)) {
    const id = `THE-${m[1]}`;
    if (!refs.has(id)) refs.set(id, { areas: new Map(), dep: new Map() });
    const rec = refs.get(id);
    if (!seen.has(id)) {
      seen.add(id); // one PATH hit per file per ticket keeps the report readable
      if (!rec.areas.has(area)) rec.areas.set(area, new Set());
      rec.areas.get(area).add(file);
    }
  }
  // Dependency phrasing is a SEPARATE pass over comment blocks, and it deliberately does not honour
  // the dedup above: the first mention of a ticket in a file is usually the header's provenance line
  // ("THE-228 — the capture bus"), and the load-bearing one ("off until THE-238 lands") comes later.
  if (!STRONG_AREAS.has(area) || file === SELF || IMMUTABLE.test(file)) continue;
  for (const block of commentBlocks(text, file.endsWith(".md"))) {
    const flat = flatten(block);
    for (const m of flat.matchAll(TICKET_RE)) {
      const id = `THE-${m[1]}`;
      const rec = refs.get(id);
      if (!rec || rec.dep.has(file) || DEP_ALLOW.has(`${file}::${id}`)) continue;
      const before = flat.slice(Math.max(0, m.index - 160), m.index);
      // The LAST dependency word before the id is the candidate; anything earlier is a different
      // clause. DEP_WORDS is /g, so matchAll is safe here and lastIndex never leaks between files.
      const hit = [...before.matchAll(DEP_WORDS)].pop();
      if (!hit) continue;
      const gap = before.slice(hit.index + hit[0].length);
      if (gap.length > DEP_MAX_GAP || /[.;!?]\s/.test(gap)) continue;
      const evidence = `${before}${flat.slice(m.index, m.index + 60)}`.trim();
      // Tense is checked over the clause AROUND the citation, not just the gap: "until THE-583 CAME
      // to replace it" puts the tell after the id, "HAS ALREADY been raised once (THE-610)" before.
      if (PAST_TENSE.test(`${before.slice(hit.index)}${flat.slice(m.index, m.index + 60)}`))
        continue;
      rec.dep.set(file, evidence);
    }
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
    'Pass --tickets <file> (JSON: [{"id":"THE-1","state":"Todo"}]) to cross-check. Include CLOSED',
  );
  console.log(
    "tickets in that list as well as open ones — the closed direction is the one nothing checked",
  );
  console.log("until 2026-08-07, and it is where THE-238 and THE-222 went wrong.");
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

// "Not started" is the failing condition for direction 1. Anything already in flight is expected
// to be cited.
const NOT_STARTED = new Set(["backlog", "todo", "triage", "unstarted"]);

// Direction 2. `canceled` and `cancelled` are both listed because Linear emits the one-l spelling
// and humans hand-writing a fixture reliably type the other; a state that falls through this set
// is silently treated as open, which would make the check under-report rather than fail loudly.
const CLOSED = new Set(["done", "completed", "canceled", "cancelled", "duplicate", "merged"]);

const strong = [];
const weak = [];
const staleDeps = [];
for (const t of tickets) {
  const rec = refs.get(t.id);
  if (!rec) continue;
  const state = String(t.state ?? "").toLowerCase();
  const row = {
    id: t.id,
    state: t.state ?? "?",
    title: t.title ?? "",
    // An allowlisted ticket is still REPORTED (its row and reason stay visible, so the list can be
    // re-derived by reading the run) but does not fail — the same shape as DEP_ALLOW.
    notStarted: NOT_STARTED.has(state) && !NOT_STARTED_ALLOW.has(t.id),
    allowReason: NOT_STARTED_ALLOW.get(t.id) ?? null,
    closed: CLOSED.has(state),
    areas: [...rec.areas.entries()].map(([area, paths]) => [area, [...paths].sort()]),
    dep: [...rec.dep.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
  // A closed ticket cited only as provenance is CORRECT and must never be flagged — that is the
  // whole reason this keys on dependency phrasing rather than on the reference existing.
  if (row.closed) {
    if (row.dep.length > 0) staleDeps.push(row);
    continue;
  }
  const hasStrong = row.areas.some(([area]) => STRONG_AREAS.has(area));
  (hasStrong ? strong : weak).push(row);
}

function report(rows, heading) {
  if (rows.length === 0) return;
  console.log(`\n${heading}`);
  for (const r of rows.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))) {
    const flag = r.notStarted ? "NOT STARTED" : r.allowReason ? "triaged" : r.state;
    console.log(`  ${r.id}  [${flag}]  ${r.title}`.trimEnd());
    // The reason is printed, not just the suppression, so the allowlist can be re-derived by
    // reading a run rather than by opening this file and trusting it.
    if (r.allowReason) console.log(`      ↳ legitimately open: ${r.allowReason}`);
    for (const [area, paths] of r.areas) {
      const shown = paths.slice(0, 3).join(", ");
      const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
      console.log(`      ${area}: ${shown}${more}`);
    }
  }
}

const closedCount = tickets.filter((t) => CLOSED.has(String(t.state ?? "").toLowerCase())).length;
console.log(
  `check-ticket-drift: ${tickets.length} tickets (${tickets.length - closedCount} open, ${closedCount} closed) vs ${refs.size} ids referenced across ${files.length} tracked files.`,
);
if (closedCount === 0) {
  console.log(
    "  NOTE: the ticket list contains no closed tickets, so the stale-dependency check cannot fire.",
  );
  console.log(
    "  Pass closed tickets too — that direction is the one that caused THE-238 and THE-222.",
  );
}
report(strong, "Referenced by CODE, CI, scripts or tests — verify against main before scheduling:");
report(
  weak,
  "Referenced only by docs (weak signal — design notes discuss unstarted work legitimately):",
);

if (staleDeps.length > 0) {
  console.log("\nCLOSED tickets cited as a LIVE DEPENDENCY in executable content:");
  for (const r of staleDeps.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))) {
    console.log(`  ${r.id}  [${r.state}]  ${r.title}`.trimEnd());
    for (const [path, evidence] of r.dep) {
      console.log(`      ${path}`);
      console.log(`        "…${evidence.slice(0, 150)}…"`);
    }
  }
}

// Direction 2 FAILS --strict, as of the 2026-08-07 triage. Getting here took four passes over the
// full board (304 tickets, 1,307 files), and the order matters: 11 real findings fixed, then
// comment-block scoping, then proximity, then tense, then a 10-entry allowlist for the residue.
// Regex does not reach zero on English — the allowlist is what makes the gate honest rather than
// approximately right, and it is keyed on file+ticket so the same id in a new file still fires.
const failing = strong.filter((r) => r.notStarted);
if (failing.length === 0 && staleDeps.length === 0) {
  console.log(
    "\ncheck-ticket-drift: no not-started ticket is referenced by executable content, and no closed",
  );
  console.log("ticket is cited as a live dependency.");
  process.exit(0);
}

if (failing.length > 0) {
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
}

if (staleDeps.length > 0) {
  console.log(
    `\ncheck-ticket-drift: ${staleDeps.length} CLOSED ticket(s) are cited as a live dependency: ${staleDeps
      .map((r) => r.id)
      .join(", ")}`,
  );
  console.log(
    "The comment promises something the ticket can no longer deliver. Rewrite it to name the",
  );
  console.log(
    "ARTIFACT or CONDITION it is actually waiting on — a condition stays true or false on its own,",
  );
  console.log("whereas a ticket id silently becomes a lie the moment the ticket closes.");
}

// Advisory by default so this can be run freely; the scheduled workflow passes --strict to go red.
process.exit(process.argv.includes("--strict") ? 1 : 0);
