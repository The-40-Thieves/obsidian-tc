import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { committedGeneratedProblems } from "./lib/tree-map-guard.mjs";

const root = join(import.meta.dirname, "..");

test("clean: prose-only TREE.md and no tracked generator output", () => {
  assert.deepEqual(
    committedGeneratedProblems({ treeText: "# map\n\nprose only\n", tracked: ["TREE.md"] }),
    [],
  );
});

test("RED: a re-committed GENERATED region in TREE.md is reported with its line", () => {
  const treeText = "a\nb\n<!-- BEGIN GENERATED: tree-scale -->\n**1 modules**\n<!-- END GENERATED: tree-scale -->\n";
  const problems = committedGeneratedProblems({ treeText, tracked: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^TREE\.md:3 /);
});

test("RED: tracking the old docs/dependency-graph.json or anything under generated/ is reported", () => {
  const problems = committedGeneratedProblems({
    treeText: "",
    tracked: ["docs/dependency-graph.json", "generated/tree-map.md", "docs/other.json"],
  });
  assert.equal(problems.length, 2);
});

test("the committed TREE.md and the real index are clean (map:check itself runs in ci-docgen)", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "TREE.md", "generated", "docs/dependency-graph.json"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.split("\n").filter(Boolean);
  assert.deepEqual(
    committedGeneratedProblems({ treeText: readFileSync(join(root, "TREE.md"), "utf8"), tracked }),
    [],
  );
});
