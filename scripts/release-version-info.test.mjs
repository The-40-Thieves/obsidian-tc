// Tests for scripts/release-version-info.mjs (THE-957).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isPrerelease, readVersion, versionInfo } from "./release-version-info.mjs";

const SCRIPT = fileURLToPath(new URL("./release-version-info.mjs", import.meta.url));

// ---- pure helpers ----------------------------------------------------------------------------

test("isPrerelease: a stable version has no hyphen", () => {
  assert.equal(isPrerelease("1.28.0"), false);
});

test("isPrerelease: an -rc.N version is a prerelease", () => {
  assert.equal(isPrerelease("1.28.0-rc.1"), true);
});

test("isPrerelease: a -beta version is a prerelease", () => {
  assert.equal(isPrerelease("1.28.0-beta"), true);
});

test("versionInfo: stable version classifies false", () => {
  assert.deepEqual(versionInfo("1.28.0"), { version: "1.28.0", prerelease: false });
});

test("versionInfo: -rc.1 version classifies true", () => {
  assert.deepEqual(versionInfo("1.28.0-rc.1"), { version: "1.28.0-rc.1", prerelease: true });
});

test("versionInfo: -beta version classifies true", () => {
  assert.deepEqual(versionInfo("1.28.0-beta"), { version: "1.28.0-beta", prerelease: true });
});

// ---- readVersion + the real package.json ---------------------------------------------------

test("readVersion: reads the repo's own packages/server/package.json by default", () => {
  const version = readVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

let tmpFile;
afterEach(() => {
  if (tmpFile) rmSync(tmpFile, { recursive: true, force: true });
  tmpFile = undefined;
});

test("readVersion: throws a clear error when version is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-version-info-test-"));
  tmpFile = dir;
  const path = join(dir, "package.json");
  writeFileSync(path, JSON.stringify({ name: "no-version-here" }));
  assert.throws(() => readVersion(path), /has no "version" field/);
});

// ---- CLI (the real script, printing JSON) --------------------------------------------------

test("CLI: prints {version, prerelease} JSON for a given package.json path", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-version-info-test-"));
  tmpFile = dir;
  const path = join(dir, "package.json");
  writeFileSync(path, JSON.stringify({ version: "1.28.0-rc.1" }));
  const output = execFileSync("node", [SCRIPT, path], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(output), { version: "1.28.0-rc.1", prerelease: true });
});

test("CLI: with no path argument, reads the repo's own server package.json", () => {
  const output = execFileSync("node", [SCRIPT], { encoding: "utf8" }).trim();
  const parsed = JSON.parse(output);
  assert.equal(parsed.version, readVersion());
  assert.equal(parsed.prerelease, isPrerelease(readVersion()));
});
