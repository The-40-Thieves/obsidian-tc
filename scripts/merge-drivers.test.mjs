// The `regen` merge driver, exercised through REAL `git merge` / `git rebase` in a scratch repo —
// the only way to know git actually invokes it and honours its result.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeEmbedded, parseEmbedded, renderEmbedded } from "./lib/embedded-migrations.mjs";

const EMBEDDED = "packages/server/src/db/migrations-embedded.ts";
const repoRoot = join(import.meta.dirname, "..");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "regen-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "scripts", "merge-drivers"), { recursive: true });
  mkdirSync(join(dir, "scripts", "lib"));
  mkdirSync(join(dir, "packages", "server", "src", "db"), { recursive: true });
  cpSync(
    join(repoRoot, "scripts/merge-drivers/regen.mjs"),
    join(dir, "scripts/merge-drivers/regen.mjs"),
  );
  cpSync(
    join(repoRoot, "scripts/lib/embedded-migrations.mjs"),
    join(dir, "scripts/lib/embedded-migrations.mjs"),
  );
  writeFileSync(join(dir, ".gitattributes"), `${EMBEDDED} merge=regen\n`);
  git("config", "merge.regen.driver", 'node "scripts/merge-drivers/regen.mjs" %O %A %B %P');
  const write = (entries) => writeFileSync(join(dir, EMBEDDED), renderEmbedded(entries));
  const read = () => readFileSync(join(dir, EMBEDDED), "utf8");
  return { dir, git, write, read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const BASE = [
  ["20260101_001_a.sql", "-- a\nCREATE TABLE a(x);\n"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the point -- the embedder must not interpolate it
  ["20260102_001_b.sql", "-- b `tick` ${not_interp}\n"],
];

test("two branches that each ADD a migration merge cleanly in either order (git merge)", () => {
  for (const order of ["ab", "ba"]) {
    const s = scratch();
    try {
      s.write(BASE);
      s.git("add", "-A");
      s.git("commit", "-qm", "base");
      s.git("checkout", "-qb", "a");
      s.write([...BASE, ["20260930_001_a_feature.sql", "-- from a\n"]]);
      s.git("commit", "-qam", "a adds");
      s.git("checkout", "-q", "main");
      s.git("checkout", "-qb", "b");
      s.write([...BASE, ["20260930_002_b_feature.sql", "-- from b\n"]]);
      s.git("commit", "-qam", "b adds");
      s.git("checkout", "-q", "main");
      const [first, second] = order === "ab" ? ["a", "b"] : ["b", "a"];
      s.git("merge", "-q", "--no-edit", first);
      s.git("merge", "-q", "--no-edit", second); // throws on a conflict
      const expected = renderEmbedded([
        ...BASE,
        ["20260930_001_a_feature.sql", "-- from a\n"],
        ["20260930_002_b_feature.sql", "-- from b\n"],
      ]);
      assert.equal(s.read(), expected, `order ${order}: merged file == fresh regeneration`);
      assert.doesNotMatch(s.read(), /<<<<<<<|>>>>>>>/);
    } finally {
      s.done();
    }
  }
});

test("git rebase of one branch onto the other also regenerates (the PR #503 shape)", () => {
  const s = scratch();
  try {
    s.write(BASE);
    s.git("add", "-A");
    s.git("commit", "-qm", "base");
    s.git("checkout", "-qb", "a");
    s.write([...BASE, ["20260930_001_a_feature.sql", "-- from a\n"]]);
    s.git("commit", "-qam", "a adds");
    s.git("checkout", "-q", "main");
    s.git("checkout", "-qb", "b");
    s.write([...BASE, ["20260930_002_b_feature.sql", "-- from b\n"]]);
    s.git("commit", "-qam", "b adds");
    s.git("checkout", "-q", "main");
    s.git("merge", "-q", "--ff-only", "a");
    s.git("checkout", "-q", "b");
    s.git("rebase", "main");
    assert.deepEqual(
      parseEmbedded(s.read()).map(([f]) => f),
      [...BASE.map(([f]) => f), "20260930_001_a_feature.sql", "20260930_002_b_feature.sql"],
    );
  } finally {
    s.done();
  }
});

test("RED: both branches editing the SAME migration differently is a real conflict, not a guess", () => {
  const s = scratch();
  try {
    s.write(BASE);
    s.git("add", "-A");
    s.git("commit", "-qm", "base");
    s.git("checkout", "-qb", "a");
    s.write([["20260101_001_a.sql", "-- edited by a\n"], BASE[1]]);
    s.git("commit", "-qam", "a edits");
    s.git("checkout", "-q", "main");
    s.git("checkout", "-qb", "b");
    s.write([["20260101_001_a.sql", "-- edited by b\n"], BASE[1]]);
    s.git("commit", "-qam", "b edits");
    s.git("checkout", "-q", "a");
    assert.throws(() => s.git("merge", "-q", "--no-edit", "b"), /CONFLICT|conflict|Command failed/);
  } finally {
    s.done();
  }
});

test("a deletion on one side survives the merge", () => {
  const s = scratch();
  try {
    s.write(BASE);
    s.git("add", "-A");
    s.git("commit", "-qm", "base");
    s.git("checkout", "-qb", "a");
    s.write([BASE[0]]);
    s.git("commit", "-qam", "a deletes b");
    s.git("checkout", "-q", "main");
    s.git("checkout", "-qb", "b");
    s.write([...BASE, ["20260930_002_b_feature.sql", "-- from b\n"]]);
    s.git("commit", "-qam", "b adds");
    s.git("merge", "-q", "--no-edit", "a");
    assert.deepEqual(
      parseEmbedded(s.read()).map(([f]) => f),
      ["20260101_001_a.sql", "20260930_002_b_feature.sql"],
    );
  } finally {
    s.done();
  }
});

test("a path the driver has no regenerator for gets a normal text merge with markers", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.dir, "other.txt"), "one\n");
    s.write(BASE);
    writeFileSync(
      join(s.dir, ".gitattributes"),
      `${EMBEDDED} merge=regen\nother.txt merge=regen\n`,
    );
    s.git("add", "-A");
    s.git("commit", "-qm", "base");
    s.git("checkout", "-qb", "a");
    writeFileSync(join(s.dir, "other.txt"), "from a\n");
    s.git("commit", "-qam", "a");
    s.git("checkout", "-q", "main");
    writeFileSync(join(s.dir, "other.txt"), "from main\n");
    s.git("commit", "-qam", "main");
    assert.throws(() => s.git("merge", "-q", "--no-edit", "a"));
    assert.match(readFileSync(join(s.dir, "other.txt"), "utf8"), /<<<<<<</);
  } finally {
    s.done();
  }
});

test("parseEmbedded round-trips the REAL committed module byte-for-byte, with a floor", () => {
  const real = readFileSync(join(repoRoot, EMBEDDED), "utf8");
  const entries = parseEmbedded(real);
  assert.ok(entries.length >= 50, `expected >= 50 migrations, parsed ${entries.length}`);
  assert.equal(renderEmbedded(entries), real);
});

test("parseEmbedded refuses a conflict-marked or hand-edited body instead of half-reading it", () => {
  const real = readFileSync(join(repoRoot, EMBEDDED), "utf8");
  assert.throws(
    () => parseEmbedded(real.replace('  "2026', '<<<<<<< ours\n  "2026')),
    /unparseable/,
  );
  assert.throws(() => parseEmbedded("nothing here"), /not found/);
});

test("mergeEmbedded: one-sided change defers, identical add is idempotent", () => {
  const o = [["a", "1"]];
  assert.deepEqual(mergeEmbedded(o, [["a", "2"]], o).entries, [["a", "2"]]);
  assert.deepEqual(mergeEmbedded(o, [...o, ["b", "x"]], [...o, ["b", "x"]]).entries, [
    ["a", "1"],
    ["b", "x"],
  ]);
  assert.deepEqual(mergeEmbedded(o, [["a", "2"]], [["a", "3"]]).conflicts, ["a"]);
});
