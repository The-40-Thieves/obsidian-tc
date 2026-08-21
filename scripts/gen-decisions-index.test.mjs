// Tests for scripts/gen-decisions-index.mjs — the docs/decisions-index.md generator that
// resolves every THE-xxx cited under packages/*/src to a public CHANGELOG or docs/ summary (see
// CONTRIBUTING.md "Inline commentary"). Exercises the pure functions directly (ticketsIn,
// parseChangelogEntries, boldSummaryOf, extractTitle, cell, renderDocument) — none of them touch
// the filesystem or a subprocess. See check-boundaries.test.mjs for why this repo's scripts/
// tests use node:test rather than vitest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  boldSummaryOf,
  cell,
  extractTitle,
  FALLBACK_LOCATION,
  FALLBACK_SUMMARY,
  parseChangelogEntries,
  renderDocument,
  ticketsIn,
} from "./gen-decisions-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------
// 1. ticketsIn: distinct THE-xxx extraction.
// ---------------------------------------------------------------------------------------------

test("ticketsIn: finds a single ticket", () => {
  assert.deepEqual(ticketsIn("see THE-42 for context"), new Set(["42"]));
});

test("ticketsIn: dedupes repeated citations of the same ticket", () => {
  assert.deepEqual(ticketsIn("THE-42 ... later, THE-42 again"), new Set(["42"]));
});

test("ticketsIn: collects multiple distinct tickets", () => {
  assert.deepEqual(ticketsIn("THE-1 and THE-2 and THE-891"), new Set(["1", "2", "891"]));
});

test("ticketsIn: word boundary — THE-42 does not also match as THE-4", () => {
  assert.deepEqual(ticketsIn("THE-42"), new Set(["42"]));
});

test("ticketsIn: empty set when nothing cited", () => {
  assert.deepEqual(ticketsIn("no tickets here"), new Set());
});

// ---------------------------------------------------------------------------------------------
// 2. parseChangelogEntries: bullet segmentation + version tracking.
// ---------------------------------------------------------------------------------------------

test("parseChangelogEntries: single bullet under a version heading", () => {
  const text = `# Changelog\n\n## [1.2.0] - 2026-01-01\n\n- **Did a thing** (THE-100).\n`;
  const entries = parseChangelogEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, "1.2.0");
  assert.deepEqual(entries[0].ticketNums, new Set(["100"]));
  assert.match(entries[0].block, /Did a thing/);
});

test("parseChangelogEntries: a wrapped continuation line joins the same bullet block", () => {
  const text = `## [1.0.0]\n\n- **Long summary that wraps\n  onto a second line** (THE-5).\n`;
  const entries = parseChangelogEntries(text);
  assert.equal(entries.length, 1);
  assert.match(entries[0].block, /Long summary that wraps onto a second line/);
});

test("parseChangelogEntries: an indented nested sub-bullet folds into the parent, not a new entry", () => {
  const text =
    "## [1.0.0]\n\n- **Parent item** (THE-9).\n  - nested detail one\n  - nested detail two\n";
  const entries = parseChangelogEntries(text);
  assert.equal(entries.length, 1);
  assert.match(entries[0].block, /nested detail one/);
  assert.match(entries[0].block, /nested detail two/);
});

test("parseChangelogEntries: two top-level bullets are two separate entries", () => {
  const text = "## [1.0.0]\n\n- **First** (THE-1).\n- **Second** (THE-2).\n";
  const entries = parseChangelogEntries(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].ticketNums, new Set(["1"]));
  assert.deepEqual(entries[1].ticketNums, new Set(["2"]));
});

test("parseChangelogEntries: a bullet before any version heading has version null", () => {
  const text = "- **Preamble bullet** (THE-3).\n";
  const entries = parseChangelogEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, null);
});

test("parseChangelogEntries: version updates across headings and applies to later bullets", () => {
  const text = "## [Unreleased]\n\n- **New** (THE-7).\n\n## [1.0.0]\n\n- **Old** (THE-8).\n";
  const entries = parseChangelogEntries(text);
  assert.equal(entries.find((e) => e.ticketNums.has("7")).version, "Unreleased");
  assert.equal(entries.find((e) => e.ticketNums.has("8")).version, "1.0.0");
});

// ---------------------------------------------------------------------------------------------
// 3. boldSummaryOf.
// ---------------------------------------------------------------------------------------------

test("boldSummaryOf: extracts the first bold span", () => {
  assert.equal(boldSummaryOf("- **A summary** (THE-1) trailing prose"), "A summary");
});

test("boldSummaryOf: collapses internal whitespace from a wrapped bullet", () => {
  assert.equal(boldSummaryOf("- **wraps  across\n  lines**"), "wraps across lines");
});

test("boldSummaryOf: null when no bold span present", () => {
  assert.equal(boldSummaryOf("- plain bullet, no bold (THE-1)"), null);
});

// ---------------------------------------------------------------------------------------------
// 4. extractTitle.
// ---------------------------------------------------------------------------------------------

test("extractTitle: first level-1 heading", () => {
  assert.equal(extractTitle("# The Title\n\nBody text.\n", "fallback.md"), "The Title");
});

test("extractTitle: falls back to the given path when no heading is present", () => {
  assert.equal(extractTitle("no heading here\n", "docs/adr/0099-x.md"), "docs/adr/0099-x.md");
});

test("extractTitle: only a level-1 heading counts, not a level-2", () => {
  assert.equal(extractTitle("## Not this\n\n# This one\n", "fallback.md"), "This one");
});

// ---------------------------------------------------------------------------------------------
// 5. cell: markdown table cell escaping.
// ---------------------------------------------------------------------------------------------

test("cell: escapes a pipe so it cannot break the table", () => {
  assert.equal(cell("a | b"), "a \\| b");
});

test("cell: collapses an embedded newline to a space", () => {
  assert.equal(cell("line one\nline two"), "line one line two");
});

test("cell: leaves ordinary text untouched", () => {
  assert.equal(cell("plain text"), "plain text");
});

// ---------------------------------------------------------------------------------------------
// 6. renderDocument.
// ---------------------------------------------------------------------------------------------

test("renderDocument: emits one table row per ticket, in the given order", () => {
  const rows = [
    { ticket: "THE-1", summary: "First", location: "CHANGELOG.md (1.0.0)", count: 2 },
    { ticket: "THE-2", summary: "Second", location: "docs/adr/0001-x.md", count: 1 },
  ];
  const doc = renderDocument(rows, 3);
  assert.match(doc, /\| THE-1 \| First \| CHANGELOG\.md \(1\.0\.0\) \| 2 \|/);
  assert.match(doc, /\| THE-2 \| Second \| docs\/adr\/0001-x\.md \| 1 \|/);
});

test("renderDocument: reports resolved vs fallback counts in the closing line", () => {
  const rows = [
    { ticket: "THE-1", summary: "Resolved one", location: "CHANGELOG.md (1.0.0)", count: 1 },
    { ticket: "THE-2", summary: FALLBACK_SUMMARY, location: FALLBACK_LOCATION, count: 1 },
  ];
  const doc = renderDocument(rows, 5);
  assert.match(doc, /2 distinct ticket\(s\) across 5 source file\(s\)/);
  assert.match(doc, /1 resolved to a public summary, 1\s*\nfall back/);
});

test("renderDocument: states the file is generated and names the regenerate command", () => {
  const doc = renderDocument([], 0);
  assert.match(doc, /generated/i);
  assert.match(doc, /bun run docs:decisions-index/);
});

// ---------------------------------------------------------------------------------------------
// 7. Non-vacuity: the generator finds a non-trivial number of tickets in the real repo tree, and
//    is idempotent (second run against its own output is a no-op).
//    Deliberately NOT a pinned exact count, unlike check-ingest-telemetry-wiring's baseline — the
//    THE-xxx population under packages/*/src grows with every ticket-referencing change in the
//    repo, so a pinned number would need bumping on unrelated PRs. A floor plus an idempotency
//    check still catches the failure mode that matters: the scan silently finding nothing.
// ---------------------------------------------------------------------------------------------

test("non-vacuity: the real repo tree yields a substantial ticket population", () => {
  const files = execFileSync("git", ["ls-files", "packages/*/src", "packages/*/src/**"], {
    encoding: "utf8",
    cwd: ROOT,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("/dist/"));

  assert.ok(files.length > 0, "expected the repo scan to find source files — fixture/setup broke");

  const allTickets = new Set();
  for (const f of files) {
    for (const num of ticketsIn(readFileSync(join(ROOT, f), "utf8"))) allTickets.add(num);
  }

  assert.ok(
    allTickets.size > 100,
    `expected well over 100 distinct THE-xxx tickets under packages/*/src, found ${allTickets.size}`,
  );
});

test("generator CLI: --check exits 0 against a freshly regenerated docs/decisions-index.md", () => {
  execFileSync("node", ["scripts/gen-decisions-index.mjs"], { cwd: ROOT });
  execFileSync("node", ["scripts/gen-decisions-index.mjs", "--check"], { cwd: ROOT });
});
