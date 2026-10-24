import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The test-scoped duplication gate (check:duplication:tests) fails on a clone that is absent from
// scripts/jscpd-tests-baseline.json. These fixtures pin that it does: a copied block fails, an
// unchanged tree passes, and a tree with no files fails rather than reporting success.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSCPD = join(ROOT, "node_modules", "jscpd", "run-jscpd.js");

// Roughly 40 lines of straight-line code: well above the 50-token floor the gate uses. `tag` makes
// two files distinct; the same tag twice is a copy.
const testFile = (name, tag) => {
  const body = Array.from(
    { length: 40 },
    (_, i) => `  const value${i} = compute(${i}, "${tag}-${i}");`,
  );
  return `export function ${name}() {\n${body.join("\n")}\n  return value0;\n}\n`;
};

const jscpd = (dir, extra) =>
  spawnSync(
    process.execPath,
    [
      JSCPD,
      "--min-tokens",
      "50",
      "--format",
      "typescript",
      "--baseline",
      join(dir, "baseline.json"),
      "--fail-on-new-clones",
      "--fail-on-empty",
      "-s",
      ...extra,
      dir,
    ],
    // Run inside the fixture so jscpd does not pick up the repo's own .jscpd.json.
    { encoding: "utf8", cwd: dir },
  );

const withFixture = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "jscpd-tests-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a copied block is a new clone and fails the gate", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), testFile("alpha", "one"));
    const baseline = jscpd(join(dir, "src"), ["--update-baseline"]);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);

    writeFileSync(join(dir, "src", "b.ts"), testFile("beta", "one"));
    const result = jscpd(join(dir, "src"), []);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  });
});

test("an unchanged tree passes against its own baseline", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), testFile("alpha", "one"));
    writeFileSync(join(dir, "src", "b.ts"), testFile("beta", "two"));
    const baseline = jscpd(join(dir, "src"), ["--update-baseline"]);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);

    const result = jscpd(join(dir, "src"), []);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test("a scan that analyzes zero files fails instead of reporting success", () => {
  withFixture((dir) => {
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "empty", "notes.md"), "# not typescript\n");
    const result = jscpd(join(dir, "empty"), []);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  });
});
