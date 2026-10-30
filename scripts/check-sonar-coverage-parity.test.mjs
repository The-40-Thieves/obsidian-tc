// Tests for scripts/check-sonar-coverage-parity.mjs. Every case feeds the pure functions
// fabricated file lists and pattern lists rather than the real sonar-project.properties and
// packages/server/vitest.config.ts, so a legitimate future edit to either file cannot turn these
// red — only a genuine parser or comparison bug can.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkSonarCoverageParity,
  parseSonarProperty,
  parseVitestCoverageExcludes,
  parseVitestCoverageIncludes,
  selectInstrumentedFiles,
} from "./check-sonar-coverage-parity.mjs";

const CONFIG_WITH_DECOY = `
export default defineConfig({
  test: {
    exclude: ["decoy/should-not-be-read/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/index.ts",
      ],
      thresholds: { lines: 80 },
    },
  },
});
`;

test("parseVitestCoverageExcludes: reads coverage.exclude, not test.exclude", () => {
  assert.deepEqual(parseVitestCoverageExcludes(CONFIG_WITH_DECOY), [
    "src/**/*.d.ts",
    "src/index.ts",
  ]);
});

test("parseVitestCoverageIncludes: reads coverage.include", () => {
  assert.deepEqual(parseVitestCoverageIncludes(CONFIG_WITH_DECOY), ["src/**/*.ts"]);
});

test("parseVitestCoverageExcludes: returns [] when there is no coverage block", () => {
  assert.deepEqual(parseVitestCoverageExcludes("export default defineConfig({ test: {} });"), []);
});

test("parseSonarProperty: splits the comma list and ignores comments and other keys", () => {
  const props = [
    "# a comment mentioning sonar.coverage.exclusions=not-real",
    "sonar.projectKey=The-40-Thieves_obsidian-tc",
    "sonar.coverage.exclusions=scripts/**, packages/server/src/cli.ts ,docs/**",
  ].join("\n");
  assert.deepEqual(parseSonarProperty(props, "sonar.coverage.exclusions"), [
    "scripts/**",
    "packages/server/src/cli.ts",
    "docs/**",
  ]);
  assert.deepEqual(parseSonarProperty(props, "sonar.missing.key"), []);
});

test("selectInstrumentedFiles: keeps only tracked files vitest's include matches", () => {
  const tracked = [
    "packages/server/src/index.ts",
    "packages/server/src/db/schema.sql",
    "packages/server/src/search/vec.ts",
  ];
  assert.deepEqual(selectInstrumentedFiles(tracked, ["src/**/*.ts"]), [
    "packages/server/src/index.ts",
    "packages/server/src/search/vec.ts",
  ]);
});

test("parity: ok when both sides reach the same verdict on every file", () => {
  const result = checkSonarCoverageParity({
    instrumentedFiles: ["packages/server/src/index.ts", "packages/server/src/search/vec.ts"],
    vitestExcludes: ["src/index.ts"],
    sonarCoverageExclusions: ["packages/server/src/index.ts"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingFromSonar, []);
  assert.deepEqual(result.missingFromVitest, []);
});

test("parity: a vitest-excluded file absent from Sonar is reported — Sonar would score it 0%", () => {
  const result = checkSonarCoverageParity({
    instrumentedFiles: ["packages/server/src/index.ts", "packages/server/src/transports/stdio.ts"],
    vitestExcludes: ["src/index.ts", "src/transports/stdio.ts"],
    sonarCoverageExclusions: ["packages/server/src/index.ts"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromSonar, ["packages/server/src/transports/stdio.ts"]);
});

test("parity: a vitest glob counts as covered by a matching Sonar glob", () => {
  // src/**/*.d.ts is not in sonar.coverage.exclusions; the repo-wide **/*.d.ts in sonar.exclusions
  // covers it. The gate must accept that rather than demand a literal copy.
  const result = checkSonarCoverageParity({
    instrumentedFiles: ["packages/server/src/db/example.d.ts", "packages/server/src/search/vec.ts"],
    vitestExcludes: ["src/**/*.d.ts"],
    sonarCoverageExclusions: ["packages/server/test/**"],
    sonarExclusions: ["**/*.d.ts"],
  });
  assert.equal(result.ok, true);
});

test("regression: a BROAD Sonar pattern hiding instrumented source is caught", () => {
  // Scoping the reverse check by the literal prefix packages/server/src/ let `packages/server/**`
  // and `**/*.ts` through untouched, although each hides every instrumented file. Reported in
  // review on the first revision of this gate; the file-based comparison is what closes it.
  for (const broad of ["packages/server/**", "**/*.ts"]) {
    const result = checkSonarCoverageParity({
      instrumentedFiles: ["packages/server/src/index.ts", "packages/server/src/search/vec.ts"],
      vitestExcludes: ["src/index.ts"],
      sonarCoverageExclusions: [broad],
      sonarExclusions: [],
    });
    assert.equal(result.ok, false, `${broad} should be caught`);
    assert.deepEqual(result.missingFromVitest, ["packages/server/src/search/vec.ts"]);
    assert.deepEqual(result.hidingPatterns, [broad]);
  }
});

test("regression: a vitest glob and an equivalent concrete Sonar entry are NOT drift", () => {
  // vitest `src/db/**` and Sonar `packages/server/src/db/types.ts` exclude the same file. A
  // literal set lookup called this drift and would have failed the lint job on a correct config.
  const result = checkSonarCoverageParity({
    instrumentedFiles: ["packages/server/src/db/types.ts", "packages/server/src/search/vec.ts"],
    vitestExcludes: ["src/db/**"],
    sonarCoverageExclusions: ["packages/server/src/db/**", "packages/server/src/db/types.ts"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, true);
});

test("regression: a concrete Sonar .d.ts entry matched by a vitest glob is NOT drift", () => {
  const result = checkSonarCoverageParity({
    instrumentedFiles: ["packages/server/src/db/example.d.ts"],
    vitestExcludes: ["src/**/*.d.ts"],
    sonarCoverageExclusions: ["packages/server/src/db/example.d.ts"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, true);
});

test("parity: non-src Sonar exclusions matching no instrumented file are ignored", () => {
  const result = checkSonarCoverageParity({
    instrumentedFiles: ["packages/server/src/index.ts"],
    vitestExcludes: ["src/index.ts"],
    sonarCoverageExclusions: [
      "packages/server/src/index.ts",
      "scripts/**",
      "docs/**",
      "**/*.config.ts",
    ],
    sonarExclusions: [],
  });
  assert.equal(result.ok, true);
});

test("parity: an empty parse fails loudly instead of passing vacuously", () => {
  const base = {
    instrumentedFiles: ["packages/server/src/index.ts"],
    vitestExcludes: ["src/index.ts"],
    sonarCoverageExclusions: ["packages/server/src/index.ts"],
    sonarExclusions: [],
  };
  const noFiles = checkSonarCoverageParity({ ...base, instrumentedFiles: [] });
  assert.equal(noFiles.ok, false);
  assert.match(noFiles.parseError, /no instrumented source files/);

  const noVitest = checkSonarCoverageParity({ ...base, vitestExcludes: [] });
  assert.equal(noVitest.ok, false);
  assert.match(noVitest.parseError, /vitest/);

  const noSonar = checkSonarCoverageParity({ ...base, sonarCoverageExclusions: [] });
  assert.equal(noSonar.ok, false);
  assert.match(noSonar.parseError, /sonar\.coverage\.exclusions/);
});
