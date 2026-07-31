// Tests for scripts/check-ingest-telemetry-wiring.mjs — the THE-590 gate that every indexVault()
// call path under packages/server/src feeds ingest telemetry. Exercises the pure functions
// directly (blankNonCode, findIndexVaultCallSites, findSinkAssignments, consumerTextAfterCall)
// rather than shelling out to git — none of them touch the filesystem or a subprocess. See
// check-boundaries.test.mjs for why this repo's scripts/ tests use node:test rather than vitest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  blankNonCode,
  consumerTextAfterCall,
  findIndexVaultCallSites,
  findSinkAssignments,
  RECORD_CALL_RE,
  SINK_DELEGATE_RE,
} from "./check-ingest-telemetry-wiring.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Determines the same "-> recordIngestStats*" / "-> onIndexVaultComplete sink" / "UNINSTRUMENTED"
// verdict main() prints for a call site, so tests can assert on the verdict without duplicating
// main()'s process.exit()-laden control flow.
function verdictFor(blankedSource, callEnd) {
  const consumerText = consumerTextAfterCall(blankedSource, callEnd);
  if (RECORD_CALL_RE.test(consumerText)) return "record";
  if (SINK_DELEGATE_RE.test(consumerText)) return "sink";
  return "UNINSTRUMENTED";
}

// ---------------------------------------------------------------------------------------------
// 1. Parse: blankNonCode preserves length and line count, and leaves real code untouched.
// ---------------------------------------------------------------------------------------------

test("blankNonCode: same length as input", () => {
  const source = `// a comment\nconst x = "a string with (parens) and indexVault(";\n/* block\n   comment */\nconst y = 1;\n`;
  assert.equal(blankNonCode(source).length, source.length);
});

test("blankNonCode: same line count as input", () => {
  const source = `line1\n// comment\nline3\n/* multi\nline\ncomment */\nlastLine\n`;
  const blanked = blankNonCode(source);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
});

test("blankNonCode: real code outside comments/strings is untouched", () => {
  const source = `export async function f() {\n  const stats = await indexVault(opts);\n  recordIngestStats(stats);\n}\n`;
  const blanked = blankNonCode(source);
  assert.match(blanked, /const stats = await indexVault\(opts\);/);
  assert.match(blanked, /recordIngestStats\(stats\);/);
});

test("blankNonCode: line comment text is blanked but the newline survives", () => {
  const source = `const a = 1; // indexVault( in a comment\nconst b = 2;\n`;
  const blanked = blankNonCode(source);
  assert.doesNotMatch(blanked, /indexVault/);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
  assert.match(blanked, /const a = 1; {2,}\nconst b = 2;\n/);
});

test("blankNonCode: block comment text is blanked, internal newlines preserved", () => {
  const source = `/* line one\n   indexVault( mentioned here\n   line three */\nconst kept = 1;\n`;
  const blanked = blankNonCode(source);
  assert.doesNotMatch(blanked, /indexVault/);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
  assert.match(blanked, /const kept = 1;/);
});

test("blankNonCode: string literal contents are blanked, quotes' surrounding code kept", () => {
  const source = `const s = "call indexVault( in a string";\nconst t = 'also recordIngestStats( here';\n`;
  const blanked = blankNonCode(source);
  assert.doesNotMatch(blanked, /indexVault/);
  assert.doesNotMatch(blanked, /recordIngestStats/);
  assert.match(blanked, /const s = {2,};/);
  assert.match(blanked, /const t = {2,};/);
});

test("blankNonCode: template literals are left completely untouched, including interpolations", () => {
  // This fixture deliberately embeds a backtick-delimited TEMPLATE literal's source text inside a
  // plain double-quoted JS string — the `${...}` is the fixture's payload, not a forgotten
  // template conversion.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: see comment above.
  const source = "const s = `call indexVault(${opts}) and recordIngestStats(stats)`;\n";
  const blanked = blankNonCode(source);
  assert.equal(blanked, source);
});

// ---------------------------------------------------------------------------------------------
// 2. Non-vacuity: blanking must not reduce the real repo's detected call-site or sink counts.
//    If this fails, the fix blanked real code — stop and report rather than "fixing" it away.
// ---------------------------------------------------------------------------------------------

test("non-vacuity: blanking the real repo tree finds the same call-site and sink counts as raw scanning", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "packages/server/src/*.ts", "packages/server/src/**/*.ts"],
    {
      encoding: "utf8",
      cwd: ROOT,
    },
  )
    .split("\n")
    .filter(Boolean);

  assert.ok(files.length > 0, "expected the repo scan to find source files — fixture/setup broke");

  let rawCallSites = 0;
  let blankedCallSites = 0;
  let rawSinks = 0;
  let blankedSinks = 0;

  for (const file of files) {
    const absPath = join(ROOT, file);
    const raw = readFileSync(absPath, "utf8");
    const blanked = blankNonCode(raw);

    rawCallSites += findIndexVaultCallSites(file, raw).length;
    blankedCallSites += findIndexVaultCallSites(file, blanked).length;
    rawSinks += findSinkAssignments(file, raw).length;
    blankedSinks += findSinkAssignments(file, blanked).length;
  }

  assert.equal(
    blankedCallSites,
    rawCallSites,
    `blanking changed the detected call-site count (${rawCallSites} -> ${blankedCallSites}) — ` +
      "this means real code got blanked, not just comments/strings",
  );
  assert.equal(
    blankedSinks,
    rawSinks,
    `blanking changed the detected sink count (${rawSinks} -> ${blankedSinks}) — this means real ` +
      "code got blanked, not just comments/strings",
  );
});

// ---------------------------------------------------------------------------------------------
// 3. True positive, both directions.
// ---------------------------------------------------------------------------------------------

test("bug 1 (false positive): prose in a comment containing indexVault(...) is not counted as a call site", () => {
  const source = `export async function realCallSite(opts) {
  // routes every direct indexVault(...) caller through the recorder below instead of a
  // per-call-site reminder.
  const stats = await indexVault(opts);
  recordIngestStats(stats);
  return stats;
}
`;
  const blanked = blankNonCode(source);
  const sites = findIndexVaultCallSites("fixture.ts", blanked);

  assert.equal(
    sites.length,
    1,
    "the comment's indexVault(...) must not be counted as a second site",
  );
  assert.equal(verdictFor(blanked, sites[0].callEnd), "record");
});

test("bug 2 (false negative): a comment mentioning recordIngestStats near an uninstrumented call is still a violation", () => {
  const source = `export async function bug2(opts) {
  const stats = await indexVault(opts);
  // TODO: eventually wire this up to recordIngestStats(stats) once the API stabilizes.
  return stats;
}
`;
  const blanked = blankNonCode(source);
  const sites = findIndexVaultCallSites("fixture.ts", blanked);

  assert.equal(sites.length, 1);
  assert.equal(
    verdictFor(blanked, sites[0].callEnd),
    "UNINSTRUMENTED",
    "the recordIngestStats mention is inside a comment and must not count as wiring",
  );
});

test("a genuinely uninstrumented call (no comment noise at all) is still caught", () => {
  const source = `export async function plainlyUninstrumented(opts) {
  const stats = await indexVault(opts);
  return stats;
}
`;
  const blanked = blankNonCode(source);
  const sites = findIndexVaultCallSites("fixture.ts", blanked);

  assert.equal(sites.length, 1);
  assert.equal(verdictFor(blanked, sites[0].callEnd), "UNINSTRUMENTED");
});

test("a genuinely instrumented call (real recordIngestStats* call in code) still passes", () => {
  const source = `export async function instrumented(opts) {
  const stats = await indexVault(opts);
  recordIngestStatsFor(opts.vaultId, stats);
  return stats;
}
`;
  const blanked = blankNonCode(source);
  const sites = findIndexVaultCallSites("fixture.ts", blanked);

  assert.equal(sites.length, 1);
  assert.equal(verdictFor(blanked, sites[0].callEnd), "record");
});

test("a call that delegates to the onIndexVaultComplete sink still passes", () => {
  const source = `export async function delegates(opts, onIndexVaultComplete) {
  const stats = await indexVault(opts);
  await onIndexVaultComplete?.(stats);
  return stats;
}
`;
  const blanked = blankNonCode(source);
  const sites = findIndexVaultCallSites("fixture.ts", blanked);

  assert.equal(sites.length, 1);
  assert.equal(verdictFor(blanked, sites[0].callEnd), "sink");
});

test("findSinkAssignments: a sink whose only recordIngestStats mention is in a comment is NOT wired", () => {
  const source = `const deps = {
  onIndexVaultComplete: async (stats) => {
    // TODO: recordIngestStats(stats) once metrics land
    indexHealth.lastChunksUpserted = stats.chunksUpserted;
  },
};
`;
  const blanked = blankNonCode(source);
  const sinks = findSinkAssignments("fixture.ts", blanked);

  assert.equal(sinks.length, 1);
  assert.equal(sinks[0].wired, false);
});

test("findSinkAssignments: a sink with a real recordIngestStats* call in its body is wired", () => {
  const source = `const deps = {
  onIndexVaultComplete: async (stats) => {
    recordIngestStatsFor(vaultId, stats);
  },
};
`;
  const blanked = blankNonCode(source);
  const sinks = findSinkAssignments("fixture.ts", blanked);

  assert.equal(sinks.length, 1);
  assert.equal(sinks[0].wired, true);
});
