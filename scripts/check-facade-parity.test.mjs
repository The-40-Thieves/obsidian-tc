// Tests for scripts/check-facade-parity.mjs — the multi-facade generalisation of
// check-export-surface.mjs. Exercises the pure functions directly (compareFacade, parseArgs)
// rather than shelling out to git: none of the covered behaviour touches the filesystem or a
// subprocess, so a fabricated source string is a faster and more precise fixture than a real repo
// state would be. See check-export-surface.test.mjs for the parser-level tests this reuses
// (parseExportedNames is imported from check-export-surface.mjs, not reimplemented here).
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareFacade, DEFAULT_FACADES, parseArgs } from "./check-facade-parity.mjs";

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
