// Tests for scripts/check-facade-parity.mjs — the multi-facade generalisation of
// check-export-surface.mjs. Exercises the pure functions directly (compareFacade, parseArgs)
// rather than shelling out to git: none of the covered behaviour touches the filesystem or a
// subprocess, so a fabricated source string is a faster and more precise fixture than a real repo
// state would be. See check-export-surface.test.mjs for the parser-level tests this reuses
// (parseExportedNames is imported from check-export-surface.mjs, not reimplemented here).
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareFacade, DEFAULT_FACADES, floorForFile, parseArgs } from "./check-facade-parity.mjs";

const floorFor = (file) => DEFAULT_FACADES.find((f) => f.file === file).floor;

// Fixture with >= 5 names so the floor does not trip on the "lost export" / "added export" cases
// below — those cases are about the MISSING-name check, not the floor. Mirrors the WIDE_BASELINE
// pattern in check-export-surface.test.mjs, sized to this gate's lower MIN_EXPORTS floor.
const FIVE_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const WIDE_BASELINE = `export {\n${FIVE_NAMES.map((n) => `  ${n},`).join("\n")}\n};`;

test("compareFacade: a lost export is detected and named", () => {
  const droppedName = FIVE_NAMES[0];
  const remaining = FIVE_NAMES.filter((n) => n !== droppedName);
  const currentSource = `export {\n${remaining.map((n) => `  ${n},`).join("\n")}\n};`;

  const result = compareFacade({
    file: "packages/shared/src/config.schema.ts",
    baselineSource: WIDE_BASELINE,
    currentSource,
  });

  assert.equal(result.status, "missing");
  assert.deepEqual(result.missing, [droppedName]);
});

test("compareFacade: an added export passes (widening is allowed)", () => {
  const currentSource = `export {\n${[...FIVE_NAMES, "BrandNewExport"]
    .map((n) => `  ${n},`)
    .join("\n")}\n};`;

  const result = compareFacade({
    file: "packages/shared/src/config.schema.ts",
    baselineSource: WIDE_BASELINE,
    currentSource,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.currentCount, 6);
});

test("compareFacade: the floor trips on a stub baseline with fewer than 5 exports", () => {
  const stubBaseline = `export const OnlyOne = 1;`;

  const result = compareFacade({
    file: "packages/shared/src/config.schema.ts",
    baselineSource: stubBaseline,
    currentSource: WIDE_BASELINE,
    floor: 5,
  });

  assert.equal(result.status, "floor");
  assert.equal(result.baselineCount, 1);
});

// The regression check-export-surface.mjs exists to prevent, re-exercised here because
// check-facade-parity.mjs imports parseExportedNames rather than reimplementing it: a checker
// matching only bare `export {` would parse zero names out of an `export type { ... }` block and
// misreport every name inside it as missing.
test("compareFacade: `export type { ... }` contents are parsed, not skipped", () => {
  const baselineSource = `
export type {
  BootstrapConfig,
  IndexingConfig,
  VaultConfig,
  AclConfig,
  AuthConfig,
};
`;
  const result = compareFacade({
    file: "packages/shared/src/config.schema.ts",
    baselineSource,
    currentSource: baselineSource,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.baselineCount, 5);
  assert.deepEqual(result.missing, []);
});

test("compareFacade: a facade absent at the baseline ref is skipped, not failed", () => {
  const result = compareFacade({
    file: "packages/server/src/search/indexer.ts",
    baselineMissing: true,
  });

  assert.equal(result.status, "skipped-new");
});

test("parseArgs: defaults to origin/main and DEFAULT_FACADES with no arguments", () => {
  const { baseline, files } = parseArgs([]);
  assert.equal(baseline, process.env.FACADE_PARITY_BASELINE_REF || "origin/main");
  // Asserted against DEFAULT_FACADES itself, not a hardcoded count — a hardcoded 3 rotted the
  // instant WP4.1 added registry.ts as a fourth facade (this test failed 4 !== 3 until fixed).
  assert.equal(files.length, DEFAULT_FACADES.length);
  // parseArgs' default `files` is plain paths (matching the explicit `--file` shape below), not
  // the {file, floor} descriptors DEFAULT_FACADES carries the floors in.
  assert.deepEqual(
    files,
    DEFAULT_FACADES.map(({ file }) => file),
  );
});

test("compareFacade: the floor named is the facade's OWN floor, not the old global 5", () => {
  // 10 names would have PASSED the pre-fix global floor of 5 and been compared normally — the
  // exact silent-collapse gap a per-facade floor closes for config.schema.ts (baseline 44, floor
  // 22 = ceil(44/2)). Below ITS floor, the gate must refuse to compare and name 22, not 5.
  const configFloor = floorFor("packages/shared/src/config.schema.ts");
  const names = Array.from({ length: 10 }, (_, i) => `Export${i}`);
  const baselineSource = `export {\n${names.map((n) => `  ${n},`).join("\n")}\n};`;

  const result = compareFacade({
    file: "packages/shared/src/config.schema.ts",
    baselineSource,
    currentSource: baselineSource,
    floor: configFloor,
  });

  assert.equal(result.status, "floor");
  assert.equal(result.baselineCount, 10);
  assert.equal(result.floor, configFloor);
  assert.ok(result.floor > 5, "should be well above the old global floor of 5");
});

test("compareFacade: above its own floor but below another facade's floor still compares normally", () => {
  // This is the exact case a single global floor gets wrong: a floor loose enough for
  // knowledge-tools.ts (baseline 6) is far too loose to catch a collapse in config.schema.ts
  // (baseline 44), and a floor tight enough for config.schema.ts fails knowledge-tools.ts
  // outright. With per-facade floors, knowledge-tools.ts's OWN floor (3) applies even though its
  // count here (4) sits below config.schema.ts's floor (22).
  const ktFloor = floorFor("packages/server/src/tools/m7/knowledge-tools.ts");
  const configFloor = floorFor("packages/shared/src/config.schema.ts");
  const names = ["Alpha", "Bravo", "Charlie", "Delta"];
  assert.ok(
    names.length > ktFloor && names.length < configFloor,
    "fixture must sit between the two floors",
  );
  const baselineSource = `export {\n${names.map((n) => `  ${n},`).join("\n")}\n};`;

  const result = compareFacade({
    file: "packages/server/src/tools/m7/knowledge-tools.ts",
    baselineSource,
    currentSource: baselineSource,
    floor: ktFloor,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.baselineCount, 4);
  assert.deepEqual(result.missing, []);
});

test("floorForFile: an explicit --file with no declared floor gets the documented fallback (5)", () => {
  assert.equal(floorForFile("packages/some/brand-new-facade-not-in-defaults.ts"), 5);
});

test("floorForFile: a file that IS in DEFAULT_FACADES gets its own declared floor", () => {
  assert.equal(
    floorForFile("packages/plugin/src/routes.ts"),
    floorFor("packages/plugin/src/routes.ts"),
  );
});

test("DEFAULT_FACADES: every declared floor is well below its own baseline count, not equal to it", () => {
  // Pins the derivation rule (floor = ceil(baseline / 2)) against the actual baseline counts, so a
  // future edit to DEFAULT_FACADES that silently reintroduces a zero-headroom floor (the bug this
  // change fixes for routes.ts) fails here rather than only showing up as a misleading "parse
  // collapsed" error the next time that facade legitimately shrinks.
  const baselineByFile = {
    "packages/shared/src/config.schema.ts": 44,
    "packages/server/src/tools/m7/knowledge-tools.ts": 6,
    "packages/server/src/search/indexer.ts": 17,
    "packages/server/src/mcp/registry.ts": 12,
    "packages/plugin/src/routes.ts": 5,
  };
  for (const { file, floor } of DEFAULT_FACADES) {
    const baseline = baselineByFile[file];
    assert.ok(baseline !== undefined, `no known baseline count for ${file}`);
    assert.equal(floor, Math.ceil(baseline / 2), `${file}: floor should be ceil(${baseline} / 2)`);
    assert.ok(
      floor < baseline,
      `${file}: floor ${floor} has no headroom below baseline ${baseline}`,
    );
  }
});

test("parseArgs: --baseline and repeated --file override the defaults", () => {
  const { baseline, files } = parseArgs([
    "--baseline",
    "mislam2/wp1.1-auth-acl-schema",
    "--file",
    "a.ts",
    "--file",
    "b.ts",
  ]);
  assert.equal(baseline, "mislam2/wp1.1-auth-acl-schema");
  assert.deepEqual(files, ["a.ts", "b.ts"]);
});
