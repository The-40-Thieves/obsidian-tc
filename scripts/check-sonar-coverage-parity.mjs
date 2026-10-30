#!/usr/bin/env node
/**
 * sonar.coverage.exclusions must stay in step with vitest's coverage `exclude`.
 *
 * Two files describe the same decision — which source files are deliberately uninstrumented — and
 * nothing connected them. sonar-project.properties says so itself: "the two are duplicated with
 * nothing gating them, so a file added there needs adding here." This is that gate.
 *
 * Drift is silent and costs accuracy in both directions:
 *
 *   - A file excluded in vitest but NOT in Sonar is uninstrumented by construction, so Sonar reads
 *     it as 0% covered. The headline figure then measures how much of the repo vitest looks at
 *     rather than how well the server is tested.
 *   - A file excluded in Sonar but still instrumented by vitest is the worse one: Sonar hides real
 *     measured coverage, and the quality gate reads a smaller, friendlier denominator than the
 *     suite actually produced.
 *
 * The comparison runs over REAL FILES, not over the pattern strings. Each tracked file matching
 * vitest's coverage `include` is tested against both sides as a predicate, and the two verdicts are
 * compared. Comparing the lists textually instead was wrong twice over, both caught in review:
 *
 *   - Scope by literal prefix let a broad Sonar pattern slip through entirely. `packages/server/**`
 *     or `**` + `/*.ts` in sonar.coverage.exclusions excludes every instrumented server file (727
 *     of them as this lands), yet neither literally starts with `packages/server/src/`, so a
 *     prefix test skipped both and the gate reported OK — the exact vacuous pass it exists to stop.
 *   - A literal set lookup called two equivalent configurations drift. vitest `src/db/**` with a
 *     concrete Sonar entry `packages/server/src/db/types.ts` exclude precisely the same file, but
 *     string equality says otherwise and the lint job would fail a correct config.
 *
 * Evaluating both sides on the same concrete paths removes the pattern algebra that caused both.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SONAR_PROPERTIES_PATH = join(ROOT, "sonar-project.properties");
export const VITEST_CONFIG_PATH = join(ROOT, "packages", "server", "vitest.config.ts");

/** vitest patterns are relative to packages/server; Sonar's are relative to the repository root. */
export const SERVER_PREFIX = "packages/server/";

/** How many offending files to name before summarising — a broad pattern can hit hundreds. */
const MAX_LISTED = 10;

function parseArrayField(source, field) {
  const coverageAt = source.indexOf("coverage:");
  if (coverageAt === -1) {
    return [];
  }
  const match = source.slice(coverageAt).match(new RegExp(`\\b${field}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Reads the arrays belonging to the `coverage` block specifically — `test.exclude` is a different
 *  list with a different job, and reading it instead would compare the wrong thing. */
export function parseVitestCoverageExcludes(source) {
  return parseArrayField(source, "exclude");
}

export function parseVitestCoverageIncludes(source) {
  return parseArrayField(source, "include");
}

/** Minimal .properties reader: the one key, comma-split, comments and other keys ignored. */
export function parseSonarProperty(source, key) {
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || line.slice(0, eq).trim() !== key) {
      continue;
    }
    return line
      .slice(eq + 1)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

/** Sonar path-matcher semantics: `**` spans directories, `*` stays inside one segment. vitest's
 *  globs use the same two forms for the patterns that appear here, so one matcher serves both. */
export function patternToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The files coverage actually considers: tracked, and matching vitest's coverage `include`. */
export function selectInstrumentedFiles(trackedFiles, vitestIncludes) {
  const matchers = vitestIncludes.map((p) => patternToRegExp(SERVER_PREFIX + p));
  return trackedFiles.filter((file) => matchers.some((re) => re.test(file)));
}

function floor(parseError) {
  return { ok: false, parseError, missingFromSonar: [], missingFromVitest: [], hidingPatterns: [] };
}

export function checkSonarCoverageParity({
  instrumentedFiles,
  vitestExcludes,
  sonarCoverageExclusions,
  sonarExclusions = [],
}) {
  // A gate that scans nothing reports success, so each input carries a non-empty floor: an empty
  // list here means something broke, not that the repo is clean.
  if (instrumentedFiles.length === 0) {
    return floor(
      "found no instrumented source files — vitest's coverage include matched nothing, so the " +
        "comparison would have passed without examining anything",
    );
  }
  if (vitestExcludes.length === 0) {
    return floor(
      "found no coverage.exclude entries in packages/server/vitest.config.ts — the parser is out " +
        "of step with the config's shape, not the config with Sonar",
    );
  }
  if (sonarCoverageExclusions.length === 0) {
    return floor(
      "found no sonar.coverage.exclusions entries in sonar-project.properties — the key is " +
        "missing or the parser is out of step with the file",
    );
  }

  const vitestMatchers = vitestExcludes.map((p) => patternToRegExp(SERVER_PREFIX + p));
  const sonarMatchers = [...sonarCoverageExclusions, ...sonarExclusions].map((pattern) => ({
    pattern,
    re: patternToRegExp(pattern),
  }));

  const missingFromSonar = [];
  const missingFromVitest = [];
  const hidingPatterns = new Set();

  for (const file of instrumentedFiles) {
    const excludedByVitest = vitestMatchers.some((re) => re.test(file));
    const sonarHit = sonarMatchers.find(({ re }) => re.test(file));
    if (excludedByVitest && !sonarHit) {
      missingFromSonar.push(file);
    } else if (!excludedByVitest && sonarHit) {
      missingFromVitest.push(file);
      hidingPatterns.add(sonarHit.pattern);
    }
  }

  return {
    ok: missingFromSonar.length === 0 && missingFromVitest.length === 0,
    parseError: null,
    missingFromSonar,
    missingFromVitest,
    hidingPatterns: [...hidingPatterns],
  };
}

function report(files) {
  for (const file of files.slice(0, MAX_LISTED)) {
    console.error(`  ${file}`);
  }
  if (files.length > MAX_LISTED) {
    console.error(`  ... and ${files.length - MAX_LISTED} more`);
  }
}

function main() {
  const sonarSource = readFileSync(SONAR_PROPERTIES_PATH, "utf8");
  const vitestSource = readFileSync(VITEST_CONFIG_PATH, "utf8");
  const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "packages/server/src"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

  const result = checkSonarCoverageParity({
    instrumentedFiles: selectInstrumentedFiles(tracked, parseVitestCoverageIncludes(vitestSource)),
    vitestExcludes: parseVitestCoverageExcludes(vitestSource),
    sonarCoverageExclusions: parseSonarProperty(sonarSource, "sonar.coverage.exclusions"),
    sonarExclusions: parseSonarProperty(sonarSource, "sonar.exclusions"),
  });

  if (result.ok) {
    console.log(
      "check-sonar-coverage-parity: OK — vitest and Sonar agree on every instrumented file under " +
        "packages/server/src.",
    );
    process.exit(0);
  }

  if (result.parseError) {
    console.error(`check-sonar-coverage-parity: ${result.parseError}.`);
    process.exit(1);
  }

  if (result.missingFromSonar.length > 0) {
    console.error(
      `check-sonar-coverage-parity: ${result.missingFromSonar.length} file(s) excluded from ` +
        "vitest coverage but not from Sonar — Sonar will score them 0% although nothing " +
        "instruments them. Add them to sonar.coverage.exclusions in sonar-project.properties:",
    );
    report(result.missingFromSonar);
  }

  if (result.missingFromVitest.length > 0) {
    console.error(
      `check-sonar-coverage-parity: ${result.missingFromVitest.length} file(s) excluded from ` +
        "Sonar but still instrumented by vitest — Sonar is hiding coverage the suite actually " +
        `measured. Responsible pattern(s): ${result.hidingPatterns.join(", ")}. Either narrow ` +
        "those entries in sonar.coverage.exclusions, or exclude the files in " +
        "packages/server/vitest.config.ts too if they genuinely hold no testable logic:",
    );
    report(result.missingFromVitest);
  }
  process.exit(1);
}

// Importing this module (as its test file does) must have no side effects — no filesystem reads,
// no process.exit. Only run the gate when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
