// Tests for scripts/check-sonar-coverage-parity.mjs. The unit cases feed the pure functions
// fabricated file lists and pattern lists rather than the real sonar-project.properties and
// packages/server/vitest.config.ts, so a legitimate future edit to either file cannot turn these
// red — only a genuine parser or comparison bug can.
//
// The CLI cases at the bottom do run the entrypoint: once against this repo (a smoke test that the
// gate agrees with the committed config) and once against a purpose-built drifted fixture repo, so
// the failure path's exit code and remediation text are exercised rather than assumed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkSonarCoverageParity,
  createPathMatcher,
  parseSonarProperty,
  parseVitestCoverageExcludes,
  parseVitestCoverageIncludes,
  selectInstrumentedFiles,
  stripJsComments,
} from "./check-sonar-coverage-parity.mjs";

const CONFIG_WITH_COMMENTED_ENTRIES = `
export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      // exclude: ["src/decoy-commented-out-array.ts"],
      exclude: [
        "src/index.ts",
        // "src/cli.ts",
        /* "src/db/types.ts", */
        "src/transports/stdio.ts",
      ],
    },
  },
});
`;

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

test("stripJsComments: preserves a glob that a naive comment regex would corrupt", () => {
  // The suggested one-line fix, /\/\*[\s\S]*?\*\//, matches the slash-star-star-slash sequence
  // inside this glob and rewrites it to "src*.ts". That is why stripping is string-aware.
  const kept = stripJsComments('exclude: ["src/**/*.ts", "src/**/*.d.ts"],');
  assert.match(kept, /"src\/\*\*\/\*\.ts"/);
  assert.match(kept, /"src\/\*\*\/\*\.d\.ts"/);
  assert.doesNotMatch(kept, /src\*\.ts/);
});

test("stripJsComments: removes line and block comments outside strings", () => {
  assert.equal(stripJsComments("a // gone\nb").trim(), "a \nb".trim());
  assert.equal(stripJsComments("x /* gone */ y"), "x  y");
  assert.equal(stripJsComments('"// kept"'), '"// kept"');
});

test("parseVitestCoverageExcludes: a commented-out entry is NOT active config", () => {
  // Collecting a commented-out entry made the gate believe vitest excluded a file it instruments,
  // so it passed while Sonar hid measured coverage — the drift it exists to catch. Reported in
  // review against the file-based revision.
  assert.deepEqual(parseVitestCoverageExcludes(CONFIG_WITH_COMMENTED_ENTRIES), [
    "src/index.ts",
    "src/transports/stdio.ts",
  ]);
});

test("parseVitestCoverageExcludes: a commented-out `exclude:` line is not mistaken for the array", () => {
  assert.ok(
    !parseVitestCoverageExcludes(CONFIG_WITH_COMMENTED_ENTRIES).includes(
      "src/decoy-commented-out-array.ts",
    ),
  );
});

test("parseVitestCoverageIncludes: survives comment stripping intact", () => {
  assert.deepEqual(parseVitestCoverageIncludes(CONFIG_WITH_COMMENTED_ENTRIES), ["src/**/*.ts"]);
});

test("regression: a narrower Sonar glob under src that vitest does not mirror is caught", () => {
  // The broad cases above cover patterns outside src. This is the stated acceptance criterion:
  // a glob UNDER packages/server/src, hiding instrumented files, with no vitest counterpart.
  const result = checkSonarCoverageParity({
    instrumentedFiles: [
      "packages/server/src/index.ts",
      "packages/server/src/search/vec.ts",
      "packages/server/src/search/bm25.ts",
    ],
    vitestExcludes: ["src/index.ts"],
    sonarCoverageExclusions: ["packages/server/src/index.ts", "packages/server/src/search/**"],
    sonarExclusions: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromVitest, [
    "packages/server/src/search/vec.ts",
    "packages/server/src/search/bm25.ts",
  ]);
  assert.deepEqual(result.hidingPatterns, ["packages/server/src/search/**"]);
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

// --- CLI entrypoint -------------------------------------------------------------------------
// main() reads the real files and shells out to git, so none of the cases above reach it. These
// run the gate as a process: once against this repository, and twice against a fixture repo
// built to drift in each direction, so the exit code and the remediation text are exercised
// rather than assumed.

const GATE = fileURLToPath(new URL("./check-sonar-coverage-parity.mjs", import.meta.url));
const REPO_ROOT = join(GATE, "..", "..");

const FIXTURE_VITEST_HEAD =
  'export default defineConfig({ test: { coverage: { include: ["src/**/*.ts"], exclude: [';

function runGate(gatePath, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [gatePath], { cwd, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// A minimal repository the gate can run against: its own copy of the script (ROOT is derived
// from the script's location), both config files, and two tracked source files in the index so
// `git ls-files` has something to return.
function buildFixture({ sonar, vitestExcludes }) {
  const dir = mkdtempSync(join(tmpdir(), "sonar-parity-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "packages", "server", "src"), { recursive: true });
  cpSync(GATE, join(dir, "scripts", "check-sonar-coverage-parity.mjs"));
  writeFileSync(join(dir, "sonar-project.properties"), sonar);
  const excludes = vitestExcludes.map((pattern) => `"${pattern}"`).join(", ");
  writeFileSync(
    join(dir, "packages", "server", "vitest.config.ts"),
    `${FIXTURE_VITEST_HEAD}${excludes}] } } });\n`,
  );
  writeFileSync(join(dir, "packages", "server", "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "packages", "server", "src", "cli.ts"), "export const b = 2;\n");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

test("CLI: the committed config passes, reporting success on stdout", () => {
  const result = runGate(GATE, REPO_ROOT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("CLI: a file vitest excludes but Sonar does not exits 1 and names it", () => {
  const dir = buildFixture({
    sonar: "sonar.coverage.exclusions=packages/server/src/index.ts\n",
    vitestExcludes: ["src/index.ts", "src/cli.ts"],
  });
  try {
    const result = runGate(join(dir, "scripts", "check-sonar-coverage-parity.mjs"), dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/server\/src\/cli\.ts/);
    assert.match(result.stderr, /sonar\.coverage\.exclusions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a Sonar pattern hiding instrumented source exits 1 and names the pattern", () => {
  const dir = buildFixture({
    sonar: "sonar.coverage.exclusions=packages/server/src/index.ts, packages/server/src/**\n",
    vitestExcludes: ["src/index.ts"],
  });
  try {
    const result = runGate(join(dir, "scripts", "check-sonar-coverage-parity.mjs"), dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/server\/src\/cli\.ts/);
    assert.match(result.stderr, /packages\/server\/src\/\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- path matching --------------------------------------------------------------------------
// The matcher replaced a glob-to-RegExp translation, so these pin the semantics both config
// files rely on, and the pathological case the generated regex could not survive.

test("createPathMatcher: the segment semantics both config files rely on", () => {
  const cases = [
    ["packages/server/src/index.ts", "packages/server/src/index.ts", true],
    ["packages/server/src/index.ts", "packages/server/src/cli.ts", false],
    ["packages/server/**", "packages/server/src/index.ts", true],
    ["**/*.d.ts", "packages/server/src/db/example.d.ts", true],
    // `**` spans ZERO directories here, which is why src/**/*.ts covers src/index.ts.
    ["packages/server/src/**/*.ts", "packages/server/src/index.ts", true],
    ["packages/server/src/**/*.ts", "packages/server/src/db/types.ts", true],
    // A single `*` stays inside its segment.
    ["packages/server/src/*.ts", "packages/server/src/db/types.ts", false],
    ["packages/server/src/db/**", "packages/server/src/db/types.ts", true],
    ["packages/server/src/inde?.ts", "packages/server/src/index.ts", true],
    ["packages/server/src/inde?.ts", "packages/server/src/indexx.ts", false],
    ["scripts/**", "packages/server/src/index.ts", false],
    ["**/*.config.ts", "vitest.config.ts", true],
  ];
  for (const [pattern, file, expected] of cases) {
    assert.equal(createPathMatcher(pattern)(file), expected, `${pattern} vs ${file}`);
  }
});

test("createPathMatcher: a regex metacharacter in a pattern matches literally", () => {
  const matches = createPathMatcher("packages/server/src/a.b+c.ts");
  assert.equal(matches("packages/server/src/a.b+c.ts"), true);
  assert.equal(matches("packages/server/src/axbxcxts"), false);
});

test("createPathMatcher: many ** segments on a long non-matching path return promptly", () => {
  // Compiled to a regex this was stacked (?:[^/]+/)* groups — catastrophic backtracking. The
  // memoised segment walk visits each position pair once, so this finishes immediately.
  const pattern = `${"**/".repeat(8)}needle.ts`;
  const file = `${"a/".repeat(40)}haystack.ts`;
  const startedAt = Date.now();
  assert.equal(createPathMatcher(pattern)(file), false);
  assert.ok(Date.now() - startedAt < 1000, `took ${Date.now() - startedAt}ms`);
});
