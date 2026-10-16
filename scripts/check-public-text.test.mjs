// Tests for scripts/check-public-text.mjs.
//
// findPublicTextViolations is pure and takes {path, content} pairs directly, so these run with no
// filesystem or git — mirroring check-mcp-name.test.mjs's injected-input shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as gate from "./check-public-text.mjs";

const { findPublicTextViolations } = gate;

// RED until the gate exports isScannedPath: the scan-set predicate decides whether a path is read
// at all, which is the part an allowlist or a narrow pathspec can silently get wrong.
function isScannedPath(path) {
  assert.equal(
    typeof gate.isScannedPath,
    "function",
    "check-public-text must export isScannedPath",
  );
  return gate.isScannedPath(path);
}

test("clean prose in a scanned file reports no violations", () => {
  const violations = findPublicTextViolations([
    { path: "README.md", content: "obsidian-tc is a governed MCP server for Obsidian vaults.\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("a bare THE-<digits> ticket id is reported with its file and line", () => {
  const violations = findPublicTextViolations([
    { path: "README.md", content: "line one\nfixed in THE-999\nline three\n" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "README.md");
  assert.equal(violations[0].line, 2);
  assert.equal(violations[0].match, "THE-999");
});

test("a lower-cased ticket id (the-998) is caught — the ticket regex is case-insensitive", () => {
  const violations = findPublicTextViolations([
    { path: "README.md", content: "fixed in the-998\n" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].match, "the-998");
});

test("the-40-thieves (the GitHub org name) is NOT a false positive under the case-insensitive ticket regex", () => {
  const violations = findPublicTextViolations([
    { path: "README.md", content: "https://github.com/The-40-Thieves/obsidian-tc\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("a linear.app URL is reported, case-insensitively", () => {
  const violations = findPublicTextViolations([
    {
      path: "docs/src/content/docs/index.md",
      content: "see https://Linear.App/the-40-thieves/issue/THE-1\n",
    },
  ]);
  // both the URL and the ticket id on the same line are separate findings
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.match).sort(), ["Linear.App", "THE-1"]);
});

test("multiple ticket ids on one line are each reported", () => {
  const violations = findPublicTextViolations([
    { path: "README.md", content: "see THE-100 and THE-200 for background\n" },
  ]);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.match).sort(), ["THE-100", "THE-200"]);
});

test("CHANGELOG.md is allowlisted — release history legitimately cites tickets", () => {
  const violations = findPublicTextViolations([
    { path: "CHANGELOG.md", content: "### Fixed\n\n- Fixed the thing (THE-42).\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("changes/ fragments are allowlisted — they are CHANGELOG text until the release folds them in", () => {
  const violations = findPublicTextViolations([
    { path: "changes/some-change.md", content: "- **A fix (THE-1).**\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("CHANGELOG.md and changes/ fragments are NOT in the scan set", () => {
  assert.equal(isScannedPath("CHANGELOG.md"), false);
  assert.equal(isScannedPath("changes/some-change.md"), false);
});

test("docs/EVALUATION.md is scanned now that it is off the allowlist", () => {
  const violations = findPublicTextViolations([
    { path: "docs/EVALUATION.md", content: "Withdrawn 2026-08-07 (THE-748).\n" },
  ]);
  assert.equal(violations.length, 1);
});

test("docs/superpowers/** is scanned at any depth (no longer allowlisted)", () => {
  const violations = findPublicTextViolations([
    { path: "docs/superpowers/plans/2026-09-03-listings/checklist.md", content: "THE-945\n" },
  ]);
  assert.equal(violations.length, 1);
});

test("docs/G2*.md is scanned (no longer allowlisted)", () => {
  const violations = findPublicTextViolations([{ path: "docs/G2.1-tools.md", content: "THE-1\n" }]);
  assert.equal(violations.length, 1);
});

test("docs/MCP-*.md is scanned (no longer allowlisted)", () => {
  const violations = findPublicTextViolations([
    { path: "docs/MCP-COMPATIBILITY.md", content: "THE-1\n" },
  ]);
  assert.equal(violations.length, 1);
});

test("a file that merely starts with an allowlisted prefix's name is NOT allowlisted", () => {
  // docs/G2.md would be allowlisted; a sibling like docs/G2-extra/notes.md (not .md at the
  // top level) must not accidentally match the glob's intent.
  const violations = findPublicTextViolations([
    { path: "docs/G2-extra/notes.md", content: "THE-1\n" },
  ]);
  assert.equal(violations.length, 1);
});

test("docs/src/content/docs pages are NOT allowlisted — this is the shipped docs site", () => {
  const violations = findPublicTextViolations([
    { path: "docs/src/content/docs/index.md", content: "THE-135\n" },
  ]);
  assert.equal(violations.length, 1);
});

test("docs/src/content/docs/roadmap.md is scanned like every other docs-site page", () => {
  const violations = findPublicTextViolations([
    { path: "docs/src/content/docs/roadmap.md", content: "THE-135\n" },
  ]);
  assert.equal(violations.length, 1);
});

test("multiple files are all scanned, each violation carries its own path", () => {
  const violations = findPublicTextViolations([
    { path: "README.md", content: "THE-1\n" },
    { path: "packages/plugin/README.md", content: "THE-2\n" },
    { path: "CHANGELOG.md", content: "THE-3\n" },
  ]);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.path).sort(), [
    "README.md",
    "packages/plugin/README.md",
  ]);
});

// Incident RED cases (verbatim lines from the scrub brief). Each path was out of the scan set or
// allowlisted before the widening, so the scan-set assertion or the violation assertion failed.

test("ARCHITECTURE.md is in the scan set: a `**Linear:** THE-n` metadata line is flagged", () => {
  assert.equal(isScannedPath("ARCHITECTURE.md"), true);
  const violations = findPublicTextViolations([
    { path: "ARCHITECTURE.md", content: "**Linear:** THE-115\n" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "ARCHITECTURE.md");
});

test("docs/G2.5-release-engineering.md: a Linear link metadata line is flagged", () => {
  const violations = findPublicTextViolations([
    {
      path: "docs/G2.5-release-engineering.md",
      content: "**Linear:** [THE-118](https://linear.app/the-13th-letter/issue/THE-118)\n",
    },
  ]);
  assert.equal(violations.length, 3);
  assert.equal(violations[0].path, "docs/G2.5-release-engineering.md");
});

test("packages/server/eval/perf/README.md: a Linear issue link is flagged", () => {
  assert.equal(isScannedPath("packages/server/eval/perf/README.md"), true);
  const violations = findPublicTextViolations([
    {
      path: "packages/server/eval/perf/README.md",
      content: "[THE-459 issue](https://linear.app/the-40-thieves/issue/THE-459)\n",
    },
  ]);
  assert.equal(violations.length, 3);
  assert.equal(violations[0].path, "packages/server/eval/perf/README.md");
});

test("docs/superpowers/specs/*.md: a Linear link is flagged (superpowers no longer allowlisted)", () => {
  const violations = findPublicTextViolations([
    {
      path: "docs/superpowers/specs/2026-07-20-perf-harness-design.md",
      content: "[THE-459](https://linear.app/the-40-thieves/issue/THE-459)\n",
    },
  ]);
  assert.equal(violations.length, 3);
});

test("a CLI string literal naming a ticket is flagged under its real path", () => {
  assert.equal(isScannedPath("packages/server/src/cli/args.ts"), true);
  const violations = findPublicTextViolations([
    { path: "packages/server/src/cli/args.ts", content: 'const hint = "see THE-701";\n' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "packages/server/src/cli/args.ts");
  assert.equal(violations[0].match, "THE-701");
});

test("a CLI code comment naming a ticket is NOT flagged — only printed string literals are", () => {
  const violations = findPublicTextViolations([
    {
      path: "packages/server/src/cli/args.ts",
      content: "// THE-826: HITL token mint. Parser: ./parse-elicit.ts.\nconst x = 1;\n",
    },
  ]);
  assert.deepEqual(violations, []);
});

test("a CLI comment after a string containing // is still a comment, and a URL in a string is still scanned", () => {
  const violations = findPublicTextViolations([
    {
      path: "packages/server/src/cli/usage.ts",
      content: 'const u = "https://linear.app/x"; // THE-9 is a comment\n',
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].match, "linear.app");
});

test("the scan set is every tracked .md, the two manifests and CLI .ts, and nothing else", () => {
  assert.equal(isScannedPath("docs/wiki/Home.md"), true);
  assert.equal(isScannedPath("mcpb/manifest.json"), true);
  assert.equal(isScannedPath("server.json"), true);
  assert.equal(isScannedPath("packages/server/src/db/schema.ts"), false);
  assert.equal(isScannedPath("packages/server/src/cli/commands/compact.ts"), true);
});
