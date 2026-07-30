// Tests for scripts/check-export-surface.mjs — the gate that diffs config.schema.ts's exported
// name set against a baseline ref. Exercises the pure functions directly (parseExportedNames,
// findMissing, evaluate) rather than shelling out to git: none of them touch the filesystem or a
// subprocess, so a fabricated source string is a faster and more precise fixture than a real repo
// state would be. See check-boundaries.test.mjs for why this repo's scripts/ tests use node:test
// rather than vitest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, findMissing, parseExportedNames } from "./check-export-surface.mjs";

test("parseExportedNames: DEFINED exports (const/type/function/class/interface/enum)", () => {
  const source = `
export const ServerConfigObject = z.object({});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export function configJsonSchema() {}
export class Foo {}
export interface Bar {}
export enum Baz {}
`;
  assert.deepEqual(
    [...parseExportedNames(source)].sort(),
    ["Bar", "Baz", "Foo", "ServerConfig", "ServerConfigObject", "configJsonSchema"].sort(),
  );
});

test("parseExportedNames: plain `export { ... }` list contents", () => {
  const source = `
export {
  AclConfigSchema,
  AuthConfigSchema,
  VaultConfigSchema,
};
`;
  assert.deepEqual([...parseExportedNames(source)].sort(), [
    "AclConfigSchema",
    "AuthConfigSchema",
    "VaultConfigSchema",
  ]);
});

// The regression this gate exists to prevent: a checker matching only bare `export {` would parse
// zero names out of an `export type { ... }` block and misreport every name inside it as missing.
test("parseExportedNames: `export type { ... }` list contents are parsed, not skipped", () => {
  const source = `
export type {
  BootstrapConfig,
  IndexingConfig,
  VaultConfig,
};
`;
  assert.deepEqual([...parseExportedNames(source)].sort(), [
    "BootstrapConfig",
    "IndexingConfig",
    "VaultConfig",
  ]);
});

test("parseExportedNames: `export { A as B }` re-export exports the alias, not the original", () => {
  const source = `export { Internal as Public };`;
  assert.deepEqual([...parseExportedNames(source)], ["Public"]);
});

test("parseExportedNames: a mixed facade file (declarations + both re-export list forms)", () => {
  const source = `
import { z } from "zod";
export type { VaultConfig } from "./config/vault.schema";
export {
  AclConfigSchema,
  VaultConfigSchema,
};
export const ServerConfigObject = z.object({});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export function configJsonSchema() {}
`;
  assert.deepEqual(
    [...parseExportedNames(source)].sort(),
    [
      "AclConfigSchema",
      "ServerConfig",
      "ServerConfigObject",
      "VaultConfig",
      "VaultConfigSchema",
      "configJsonSchema",
    ].sort(),
  );
});

test("findMissing: names in baseline but not current, sorted", () => {
  const baseline = new Set(["B", "A", "C"]);
  const current = new Set(["A"]);
  assert.deepEqual(findMissing(baseline, current), ["B", "C"]);
});

test("findMissing: nothing missing when current is a superset", () => {
  const baseline = new Set(["A", "B"]);
  const current = new Set(["A", "B", "C"]);
  assert.deepEqual(findMissing(baseline, current), []);
});

// Fixture with >= 30 names so the floor does not trip on the "lost export" / "added export" cases
// below — those cases are about the MISSING-name check, not the floor.
const THIRTY_NAMES = Array.from({ length: 30 }, (_, i) => `Name${i}`);
const WIDE_BASELINE = `export {\n${THIRTY_NAMES.map((n) => `  ${n},`).join("\n")}\n};`;

test("evaluate: a lost export (present at baseline, absent now) fails, naming the symbol", () => {
  const droppedName = THIRTY_NAMES[0];
  const currentNames = THIRTY_NAMES.filter((n) => n !== droppedName);
  const currentSource = `export {\n${currentNames.map((n) => `  ${n},`).join("\n")}\n};`;

  const result = evaluate({ baselineSource: WIDE_BASELINE, currentSource });

  assert.equal(result.status, "missing");
  assert.deepEqual(result.missing, [droppedName]);
});

test("evaluate: an added export (present now, not at baseline) passes", () => {
  const currentSource = `export {\n${[...THIRTY_NAMES, "BrandNewExport"]
    .map((n) => `  ${n},`)
    .join("\n")}\n};`;

  const result = evaluate({ baselineSource: WIDE_BASELINE, currentSource });

  assert.equal(result.status, "ok");
  assert.equal(result.currentCount, 31);
});

test("evaluate: the floor trips on a stub baseline (fewer than `floor` exports)", () => {
  const stubBaseline = `export const OnlyOne = 1;`;
  const result = evaluate({
    baselineSource: stubBaseline,
    currentSource: WIDE_BASELINE,
    floor: 30,
  });

  assert.equal(result.status, "floor");
  assert.equal(result.baselineCount, 1);
});

test("evaluate: the floor does not trip when baseline meets it exactly", () => {
  const result = evaluate({
    baselineSource: WIDE_BASELINE,
    currentSource: WIDE_BASELINE,
    floor: 30,
  });

  assert.equal(result.status, "ok");
});
