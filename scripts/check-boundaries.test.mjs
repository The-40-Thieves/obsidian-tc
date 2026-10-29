import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cruiseSourceFiles } from "./lib/dependency-cruiser.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixture(t) {
  const cache = join(root, ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "dependency graph "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = (name) => relative(root, join(dir, name)).replaceAll("\\", "/");
  const write = (name, content) => writeFileSync(join(dir, name), content);
  write("entry.js", 'import "./target.js";\n');
  write("target.js", "export const target = true;\n");
  write("ignored.js", "export const ignored = true;\n");
  write(
    "rules.cjs",
    `module.exports = ${JSON.stringify({
      forbidden: [
        {
          name: "fixture-boundary",
          severity: "error",
          from: { path: "entry\\.js$" },
          to: { path: "target\\.js$" },
        },
      ],
      options: { exclude: { path: "ignored\\.js$" } },
    })};\n`,
  );
  return {
    files: [path("entry.js"), path("target.js"), path("ignored.js")],
    configFile: path("rules.cjs"),
    knownViolationsFile: path("known.json"),
    write,
  };
}

test("the API preserves CLI modules, exclusions and error-severity violations", async (t) => {
  const f = fixture(t);
  const actual = await cruiseSourceFiles(f.files, f);
  const cli = fileURLToPath(
    new URL("../../bin/dependency-cruiser.mjs", import.meta.resolve("dependency-cruiser")),
  );
  const expected = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, ...f.files, "--config", f.configFile, "--output-type", "json"],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.deepEqual(actual.modules, expected.modules);
  assert.deepEqual(actual.summary.violations, expected.summary.violations);
  assert.equal(actual.summary.totalCruised, 2);
  assert.equal(actual.summary.violations[0].rule.severity, "error");
});

test("only requested known violations are ignored; new violations remain errors", async (t) => {
  const f = fixture(t);
  const first = await cruiseSourceFiles(f.files, f);
  f.write("known.json", JSON.stringify(first.summary.violations));
  const known = await cruiseSourceFiles(f.files, { ...f, ignoreKnown: true });
  assert.equal(known.summary.violations[0].rule.severity, "ignore");
  const unfiltered = await cruiseSourceFiles(f.files, f);
  assert.equal(unfiltered.summary.violations[0].rule.severity, "error");
  f.write("known.json", "[]");
  const newViolation = await cruiseSourceFiles(f.files, { ...f, ignoreKnown: true });
  assert.equal(newViolation.summary.violations[0].rule.severity, "error");
});

test("an explicit source list larger than Windows argv limits is analyzed", async (t) => {
  const f = fixture(t);
  const files = Array.from({ length: 2000 }, (_, i) => f.files[i % f.files.length]);
  assert.ok(files.join(" ").length > 32767);
  const report = await cruiseSourceFiles(files, f);
  assert.equal(report.summary.totalCruised, 2);
  assert.equal(report.summary.violations[0].rule.severity, "error");
});

test("empty input, missing files and invalid configuration fail rather than passing", async (t) => {
  const f = fixture(t);
  await assert.rejects(cruiseSourceFiles([], f), /no source files/);
  await assert.rejects(cruiseSourceFiles(["missing-source.ts"], f), /missing-source/);
  f.write("rules.cjs", "this is not JavaScript");
  await assert.rejects(cruiseSourceFiles(f.files, f));
});

test("a requested missing or malformed known-violation file fails closed", async (t) => {
  const f = fixture(t);
  await assert.rejects(cruiseSourceFiles(f.files, { ...f, ignoreKnown: true }), /known\.json/);
  f.write("known.json", "{broken");
  await assert.rejects(cruiseSourceFiles(f.files, { ...f, ignoreKnown: true }), SyntaxError);
});
