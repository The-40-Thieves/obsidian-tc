// Tests for scripts/check-sonar-coverage-parity.mjs. Every case feeds the pure functions
// fabricated pattern lists rather than the real sonar-project.properties and
// packages/server/vitest.config.ts, so a legitimate future edit to either file cannot turn these
// red — only a genuine parser or comparison bug can.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkSonarCoverageParity,
  parseSonarProperty,
  parseVitestCoverageExcludes,
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
  const excludes = parseVitestCoverageExcludes(CONFIG_WITH_DECOY);
  assert.deepEqual(excludes, ["src/**/*.d.ts", "src/index.ts"]);
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

test("parity: ok when every vitest exclude is covered by a Sonar pattern", () => {
  const result = checkSonarCoverageParity({
    vitestExcludes: ["src/index.ts", "src/cli.ts"],
    sonarCoverageExclusions: ["packages/server/src/index.ts", "packages/server/src/cli.ts"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingFromSonar, []);
  assert.deepEqual(result.missingFromVitest, []);
});

test("parity: a vitest exclude absent from Sonar is reported — Sonar would score it 0%", () => {
  const result = checkSonarCoverageParity({
    vitestExcludes: ["src/index.ts", "src/transports/stdio.ts"],
    sonarCoverageExclusions: ["packages/server/src/index.ts"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromSonar, ["packages/server/src/transports/stdio.ts"]);
});

test("parity: a glob vitest exclude counts as covered by a matching Sonar glob", () => {
  // src/**/*.d.ts is not listed in sonar.coverage.exclusions; it is covered by the repo-wide
  // **/*.d.ts in sonar.exclusions. The gate must accept that rather than demand a literal copy.
  const result = checkSonarCoverageParity({
    vitestExcludes: ["src/**/*.d.ts"],
    sonarCoverageExclusions: ["packages/server/test/**"],
    sonarExclusions: ["**/*.d.ts"],
  });
  assert.equal(result.ok, true);
});

test("parity: Sonar hiding a src file vitest instruments is reported — coverage under-reads", () => {
  const result = checkSonarCoverageParity({
    vitestExcludes: ["src/index.ts"],
    sonarCoverageExclusions: [
      "packages/server/src/index.ts",
      "packages/server/src/search/vec.ts",
      "packages/server/test/**",
    ],
    sonarExclusions: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromVitest, ["packages/server/src/search/vec.ts"]);
});

test("parity: non-src Sonar exclusions are not expected to appear in vitest", () => {
  // vitest's coverage `include` is src/**/*.ts, so scripts/, docs/ and test/ are uninstrumented by
  // construction. Only packages/server/src/** entries are in scope for the reverse direction.
  const result = checkSonarCoverageParity({
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
  // A gate that scans nothing reports success. Both inputs therefore carry a non-empty floor.
  const noVitest = checkSonarCoverageParity({
    vitestExcludes: [],
    sonarCoverageExclusions: ["packages/server/src/index.ts"],
    sonarExclusions: [],
  });
  assert.equal(noVitest.ok, false);
  assert.match(noVitest.parseError, /vitest/);

  const noSonar = checkSonarCoverageParity({
    vitestExcludes: ["src/index.ts"],
    sonarCoverageExclusions: [],
    sonarExclusions: [],
  });
  assert.equal(noSonar.ok, false);
  assert.match(noSonar.parseError, /sonar\.coverage\.exclusions/);
});
