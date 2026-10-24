import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The test-scoped duplication gate (check:duplication:tests) compares packages/server/test with the
// clones on origin/main, computed at run time, and fails past failOnNewClones new ones. These tests
// run jscpd with the real .jscpd.tests.json against a fixture git repo. The only key they change is
// `path`, so deleting failOnNewClones, baselineFromRef or failOnEmpty from the real config fails them.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSCPD = join(ROOT, "node_modules", "jscpd", "run-jscpd.js");
const CONFIG = JSON.parse(readFileSync(join(ROOT, ".jscpd.tests.json"), "utf8"));

// Roughly 40 lines of straight-line code: well above the 50-token floor the gate uses. `tag` makes
// two files distinct; the same tag twice is a copy.
const testFile = (name, tag) => {
  const body = Array.from(
    { length: 40 },
    (_, i) => `  const value${i} = compute(${i}, "${tag}-${i}");`,
  );
  return `export function ${name}() {\n${body.join("\n")}\n  return value0;\n}\n`;
};

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
};

// Commits `files` as origin/main, the ref the gate compares against. Writes made after this call are
// the working tree the gate scans.
const commitBase = (dir, files) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
};

const jscpd = (dir, path) => {
  writeFileSync(join(dir, ".jscpd.json"), JSON.stringify({ ...CONFIG, path: [path] }));
  return spawnSync(process.execPath, [JSCPD, "--config", ".jscpd.json"], {
    encoding: "utf8",
    cwd: dir,
  });
};

const withFixture = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "jscpd-tests-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("one new copied block passes the real failOnNewClones allowance", () => {
  withFixture((dir) => {
    commitBase(dir, { "src/a.ts": testFile("alpha", "one") });
    writeFileSync(join(dir, "src", "b.ts"), testFile("beta", "one"));
    const result = jscpd(dir, "src");
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test("new clones past the failOnNewClones allowance fail the gate", () => {
  withFixture((dir) => {
    commitBase(dir, { "src/a.ts": testFile("alpha", "one") });
    for (const name of ["b", "c", "d", "e"]) {
      writeFileSync(join(dir, "src", `${name}.ts`), testFile(name, "one"));
    }
    const result = jscpd(dir, "src");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  });
});

test("a clone already on origin/main is not new and passes", () => {
  withFixture((dir) => {
    commitBase(dir, {
      "src/a.ts": testFile("alpha", "one"),
      "src/b.ts": testFile("beta", "one"),
    });
    const result = jscpd(dir, "src");
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test("a scan that analyzes zero files fails instead of reporting success", () => {
  withFixture((dir) => {
    commitBase(dir, { "empty/notes.md": "# not typescript\n" });
    const result = jscpd(dir, "empty");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  });
});

test("a missing origin/main fails with a message naming the ref, not a pass", () => {
  withFixture((dir) => {
    commitBase(dir, { "src/a.ts": testFile("alpha", "one") });
    git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    const result = jscpd(dir, "src");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /origin\/main/);
  });
});
