// Tests for scripts/check-mcp-name.mjs (THE-940).
//
// `mcpNameProblems` is pure and takes its inputs directly, so these run with no filesystem —
// mirroring check-merge-driver.test.mjs's injected-dependency shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpNameProblems } from "./check-mcp-name.mjs";

const NAME = "io.github.The-40-Thieves/obsidian-tc";
const DESC = "Model-agnostic, agent-ready Obsidian MCP server with RBAC, SLSA provenance.";

test("agreeing mcpName and an in-cap description pass with no problems", () => {
  const problems = mcpNameProblems({ serverName: NAME, pkgMcpName: NAME, description: DESC });
  assert.deepEqual(problems, []);
});

test("a missing mcpName is reported", () => {
  const problems = mcpNameProblems({ serverName: NAME, pkgMcpName: undefined, description: DESC });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing an `mcpName`/);
});

test("a case mismatch is reported — the registry check is case-sensitive", () => {
  const problems = mcpNameProblems({
    serverName: NAME,
    pkgMcpName: "io.github.the-40-thieves/obsidian-tc",
    description: DESC,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not exactly match/);
});

test("a differing name is reported", () => {
  const problems = mcpNameProblems({
    serverName: NAME,
    pkgMcpName: "io.github.The-40-Thieves/obsidian-tc-server",
    description: DESC,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not exactly match/);
});

test("a description exactly at the 100-char cap passes", () => {
  const description = "x".repeat(100);
  const problems = mcpNameProblems({ serverName: NAME, pkgMcpName: NAME, description });
  assert.deepEqual(problems, []);
});

test("a description one character over the cap fails", () => {
  const description = "x".repeat(101);
  const problems = mcpNameProblems({ serverName: NAME, pkgMcpName: NAME, description });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /101 characters, over the registry's 100-character cap/);
});

test("a missing description is reported", () => {
  const problems = mcpNameProblems({ serverName: NAME, pkgMcpName: NAME, description: undefined });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing a `description`/);
});

test("an empty-string description is reported (not silently accepted as present)", () => {
  const problems = mcpNameProblems({ serverName: NAME, pkgMcpName: NAME, description: "" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing a `description`/);
});

test("both a name mismatch and an over-cap description are reported together", () => {
  const problems = mcpNameProblems({
    serverName: NAME,
    pkgMcpName: "wrong/name",
    description: "x".repeat(150),
  });
  assert.equal(problems.length, 2);
});

test("a custom descriptionMax is honored", () => {
  const problems = mcpNameProblems({
    serverName: NAME,
    pkgMcpName: NAME,
    description: "x".repeat(11),
    descriptionMax: 10,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /11 characters, over the registry's 10-character cap/);
});
