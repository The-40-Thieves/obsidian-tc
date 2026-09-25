// Tests for scripts/check-public-text.mjs.
//
// findPublicTextViolations is pure and takes {path, content} pairs directly, so these run with no
// filesystem or git — mirroring check-mcp-name.test.mjs's injected-input shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPublicTextViolations } from "./check-public-text.mjs";

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

test("docs/EVALUATION.md is allowlisted", () => {
  const violations = findPublicTextViolations([
    { path: "docs/EVALUATION.md", content: "Withdrawn 2026-08-07 (THE-748).\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("docs/decisions-index.md is allowlisted — it exists only to index ticket references", () => {
  const violations = findPublicTextViolations([
    { path: "docs/decisions-index.md", content: "- THE-1 — some decision\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("docs/superpowers/** is allowlisted at any depth", () => {
  const violations = findPublicTextViolations([
    { path: "docs/superpowers/plans/2026-09-03-listings/checklist.md", content: "THE-945\n" },
  ]);
  assert.deepEqual(violations, []);
});

test("docs/G2*.md is allowlisted", () => {
  const violations = findPublicTextViolations([{ path: "docs/G2.1-tools.md", content: "THE-1\n" }]);
  assert.deepEqual(violations, []);
});

test("docs/MCP-*.md is allowlisted", () => {
  const violations = findPublicTextViolations([
    { path: "docs/MCP-COMPATIBILITY.md", content: "THE-1\n" },
  ]);
  assert.deepEqual(violations, []);
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

test("docs/src/content/docs/roadmap.md is TEMPORARILY allowlisted (see the comment in the source)", () => {
  const violations = findPublicTextViolations([
    { path: "docs/src/content/docs/roadmap.md", content: "THE-135\n" },
  ]);
  assert.deepEqual(violations, []);
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
