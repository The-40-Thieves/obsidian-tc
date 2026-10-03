import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleUnreleased,
  changelogWithFragments,
  parseFragment,
  readFragments,
  rollUnreleased,
} from "./lib/changes.mjs";

const frag = (type, body, extra = "") => `---\ntype: ${type}\n${extra}---\n${body}\n`;

test("parseFragment accepts a typed bullet and rejects every malformed shape", () => {
  const ok = parseFragment(frag("Added", "- **A.** did a thing (#1)."), "changes/a.md");
  assert.equal(ok.type, "Added");
  assert.match(ok.body, /^- \*\*A\.\*\*/);
  assert.throws(() => parseFragment("- no front matter", "changes/x.md"), /front matter/);
  assert.throws(() => parseFragment(frag("Bogus", "- x"), "changes/x.md"), /type must be/);
  assert.throws(() => parseFragment(frag("Added", ""), "changes/x.md"), /empty body/);
  assert.throws(
    () => parseFragment(frag("Added", "prose, not a bullet"), "changes/x.md"),
    /bullet/,
  );
  assert.throws(
    () => parseFragment("---\ntype: Added\nwho: me\n---\n- x\n", "changes/x.md"),
    /unknown front matter key "who"/,
  );
});

test("config-schema-change front matter is parsed into a key list", () => {
  const f = parseFragment(
    frag("Changed", "- **C.** x", "config-schema-change: a.b, c.d\n"),
    "changes/c.md",
  );
  assert.deepEqual(f.schemaChange, ["a.b", "c.d"]);
});

test("assembleUnreleased appends to an existing section and creates missing ones in canonical order", () => {
  const legacy = "### Added\n\n- **old** entry.\n\n### Fixed\n\n- **old fix.**";
  const out = assembleUnreleased(legacy, [
    parseFragment(frag("Added", "- **new one.**"), "changes/b.md"),
    parseFragment(frag("Fixed", "- **new fix.**"), "changes/c.md"),
    parseFragment(frag("Security", "- **sec.**"), "changes/d.md"),
  ]);
  assert.equal(
    out,
    "### Added\n\n- **old** entry.\n\n- **new one.**\n\n### Fixed\n\n- **old fix.**\n\n- **new fix.**\n\n### Security\n\n- **sec.**",
  );
});

test("assembleUnreleased is order independent for fragments (sorted by the reader, not the caller)", () => {
  const dir = mkdtempSync(join(tmpdir(), "chg-"));
  try {
    mkdirSync(join(dir, "changes"));
    writeFileSync(join(dir, "changes", "zz.md"), frag("Added", "- **zz.**"));
    writeFileSync(join(dir, "changes", "aa.md"), frag("Added", "- **aa.**"));
    writeFileSync(join(dir, "changes", "README.md"), "# not a fragment\n");
    const fragments = readFragments(dir);
    assert.deepEqual(
      fragments.map((f) => f.file),
      ["changes/aa.md", "changes/zz.md"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CL =
  "# Changelog\n\nintro\n\n## [Unreleased]\n\n### Added\n\n- **legacy.**\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- **first.**\n";

test("rollUnreleased folds fragments into a dated section and leaves history untouched", () => {
  const { text, body } = rollUnreleased(
    CL,
    [parseFragment(frag("Fixed", "- **fix (#9).**"), "changes/f.md")],
    "1.1.0",
    "2026-02-02",
  );
  assert.match(body, /### Added\n\n- \*\*legacy\.\*\*\n\n### Fixed\n\n- \*\*fix \(#9\)\.\*\*/);
  assert.equal(
    text,
    "# Changelog\n\nintro\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-02\n\n" +
      `${body}\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- **first.**\n`,
  );
});

test("rollUnreleased works with fragments only, and refuses when there is nothing to release", () => {
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- x\n";
  assert.throws(() => rollUnreleased(empty, [], "1.1.0", "2026-02-02"), /empty/);
  const { body } = rollUnreleased(
    empty,
    [parseFragment(frag("Added", "- **only.**"), "changes/o.md")],
    "1.1.0",
    "2026-02-02",
  );
  assert.equal(body, "### Added\n\n- **only.**");
  assert.throws(() => rollUnreleased("no heading", [], "1.1.0", "d"), /no \[Unreleased\]/);
});

test("changelogWithFragments is the read-only view used by the index and the lag check", () => {
  const view = changelogWithFragments(CL, [
    parseFragment(frag("Fixed", "- **frag fix.**"), "changes/f.md"),
  ]);
  assert.match(
    view,
    /## \[Unreleased\]\n\n### Added\n\n- \*\*legacy\.\*\*\n\n### Fixed\n\n- \*\*frag fix\.\*\*\n\n## \[1\.0\.0\]/,
  );
  assert.equal(changelogWithFragments(CL, []), CL);
});

test("check-changes exits non-zero on a bad fragment and zero on a good tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "chg-"));
  try {
    mkdirSync(join(dir, "changes"));
    writeFileSync(join(dir, "changes", "ok.md"), frag("Added", "- **ok.**"));
    const run = () =>
      spawnSync(process.execPath, [join(import.meta.dirname, "check-changes.mjs"), dir], {
        encoding: "utf8",
      });
    assert.equal(run().status, 0);
    writeFileSync(join(dir, "changes", "bad.md"), "no front matter");
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /changes\/bad\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no fragments, rolling the REAL CHANGELOG is byte-identical to the pre-fragment algorithm", async () => {
  const { readFileSync } = await import("node:fs");
  const real = readFileSync(join(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");
  const marker = "## [Unreleased]";
  // Right after a release [Unreleased] is empty and rolling it refuses, so give it one entry; the
  // rest of the real file (every released section) is still the input under test.
  const cl = /## \[Unreleased\]\s*\n## \[/.test(real)
    ? real.replace(marker, `${marker}\n\n### Fixed\n\n- **Placeholder.** Test-only entry.`)
    : real;
  const at = cl.indexOf(marker);
  const afterMarker = at + marker.length;
  const nextHeading = cl.indexOf("\n## [", afterMarker);
  const body = (
    nextHeading === -1 ? cl.slice(afterMarker) : cl.slice(afterMarker, nextHeading)
  ).trim();
  const legacy =
    cl.slice(0, at) +
    `## [Unreleased]\n\n## [9.9.9] - 2030-01-01\n\n${body}\n` +
    (nextHeading === -1 ? "\n" : `\n${cl.slice(nextHeading + 1)}`);
  assert.equal(rollUnreleased(cl, [], "9.9.9", "2030-01-01").text, legacy);
});
