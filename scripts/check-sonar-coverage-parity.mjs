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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SONAR_PROPERTIES_PATH = join(ROOT, "sonar-project.properties");
export const VITEST_CONFIG_PATH = join(ROOT, "packages", "server", "vitest.config.ts");

/** vitest patterns are relative to packages/server; Sonar's are relative to the repository root. */
export const SERVER_PREFIX = "packages/server/";

/** How many offending files to name before summarising — a broad pattern can hit hundreds. */
const MAX_LISTED = 10;

// Removes JS comments while respecting string literals.
//
// Without this, a commented-out entry inside the array is collected as an active pattern, and the
// gate then believes vitest excludes a file it actually instruments: it passes while Sonar hides
// measured coverage, which is the precise drift it exists to catch. Reported in review.
//
// A plain comment-stripping regex cannot do this. The obvious one matches the slash-star-star-slash
// sequence inside the glob "src/**" + "/*.ts", rewriting it to "src*.ts" and silently breaking the
// most common pattern in the config. Only a scan that tracks whether it is inside a quote is safe,
// which is why the suggested one-line regex fix was not taken.
export function stripJsComments(source) {
  let out = "";
  let quote = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// The field name is NOT interpolated into a pattern. There are exactly two arrays to read, so
// each caller passes its own literal regex; building one from a variable would be a regex
// assembled from data, which a security scan flags and which this file has no need for.
function parseArrayField(source, arrayPattern) {
  // Comments go first, so neither a commented-out entry nor a commented-out `exclude:` line can be
  // read as configuration, and a `]` inside a comment cannot truncate the array early.
  const code = stripJsComments(source);
  const coverageAt = code.indexOf("coverage:");
  if (coverageAt === -1) {
    return [];
  }
  const match = code.slice(coverageAt).match(arrayPattern);
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Reads the arrays belonging to the `coverage` block specifically — `test.exclude` is a different
 *  list with a different job, and reading it instead would compare the wrong thing. */
export function parseVitestCoverageExcludes(source) {
  return parseArrayField(source, /\bexclude\s*:\s*\[([^\]]*)\]/);
}

export function parseVitestCoverageIncludes(source) {
  return parseArrayField(source, /\binclude\s*:\s*\[([^\]]*)\]/);
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

/** Sonar path-matcher semantics, walked directly rather than compiled into a regex: a `**`
 *  segment spans zero or more directories, `*` stays inside one segment, `?` is one character.
 *  vitest's globs use the same forms, so one matcher serves both files.
 *
 *  Nothing here builds a pattern from data. Translating a glob into `new RegExp` hands the
 *  generated source nested quantifiers — two `**` segments become `(?:[^/]+/)*(?:[^/]+/)*`,
 *  which backtracks badly on a long non-matching path. Walking segments cannot: a failed
 *  (pattern position, path position) pair is remembered, so the walk visits each pair at most
 *  once and several `**` segments cost a product of positions rather than a product of paths.
 *
 *  `**` spans directories only as a WHOLE segment, which is how every pattern in both files is
 *  written (`scripts/**`, `**` + `/*.d.ts`, `packages/server/src/db/**`). Mixed into a segment
 *  it behaves like `*` and stays inside that segment. */
export function createPathMatcher(pattern) {
  const patternSegments = pattern.split("/");
  return (file) => matchSegments(patternSegments, 0, file.split("/"), 0, new Set());
}

/** Memoised on the (pattern position, path position) pair: a pair that failed once fails always,
 *  since matching from a pair depends on nothing else. Without this, every `**` multiplies the
 *  work of the one after it. */
function matchSegments(patternSegments, patternIndex, pathSegments, pathIndex, failed) {
  const state = patternIndex * (pathSegments.length + 1) + pathIndex;
  if (failed.has(state)) {
    return false;
  }
  const matched = matchFrom(patternSegments, patternIndex, pathSegments, pathIndex, failed);
  if (!matched) {
    failed.add(state);
  }
  return matched;
}

function matchFrom(patternSegments, patternIndex, pathSegments, pathIndex, failed) {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }
  if (patternSegments[patternIndex] === "**") {
    for (let skipTo = pathIndex; skipTo <= pathSegments.length; skipTo += 1) {
      if (matchSegments(patternSegments, patternIndex + 1, pathSegments, skipTo, failed)) {
        return true;
      }
    }
    return false;
  }
  if (pathIndex === pathSegments.length) {
    return false;
  }
  if (!matchSegment(patternSegments[patternIndex], pathSegments[pathIndex])) {
    return false;
  }
  return matchSegments(patternSegments, patternIndex + 1, pathSegments, pathIndex + 1, failed);
}

/** Wildcard match within one segment. The only backtrack point is the most recent `*`, and it
 *  only ever advances, so this is linear in the segment's length. */
function matchSegment(pattern, segment) {
  let patternIndex = 0;
  let segmentIndex = 0;
  let starIndex = -1;
  let starMatchEnd = 0;
  while (segmentIndex < segment.length) {
    const ch = pattern[patternIndex];
    if (patternIndex < pattern.length && (ch === "?" || ch === segment[segmentIndex])) {
      patternIndex += 1;
      segmentIndex += 1;
    } else if (patternIndex < pattern.length && ch === "*") {
      starIndex = patternIndex;
      starMatchEnd = segmentIndex;
      patternIndex += 1;
    } else if (starIndex !== -1) {
      starMatchEnd += 1;
      patternIndex = starIndex + 1;
      segmentIndex = starMatchEnd;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

/** The files coverage actually considers: present under packages/server/src, and matching
 *  vitest's coverage `include`. */
export function selectInstrumentedFiles(trackedFiles, vitestIncludes) {
  const matchers = vitestIncludes.map((p) => createPathMatcher(SERVER_PREFIX + p));
  return trackedFiles.filter((file) => matchers.some((matches) => matches(file)));
}

function floor(parseError) {
  return { ok: false, parseError, missingFromSonar: [], missingFromVitest: [], hidingPatterns: [] };
}

/** A gate that scans nothing reports success, so each input carries a non-empty floor: an empty
 *  list means something broke, not that the repo is clean. Returns the first breach, or null. */
function firstFloorError({ instrumentedFiles, vitestExcludes, sonarCoverageExclusions }) {
  if (instrumentedFiles.length === 0) {
    return (
      "found no instrumented source files — vitest's coverage include matched nothing, so the " +
      "comparison would have passed without examining anything"
    );
  }
  if (vitestExcludes.length === 0) {
    return (
      "found no coverage.exclude entries in packages/server/vitest.config.ts — the parser is out " +
      "of step with the config's shape, not the config with Sonar"
    );
  }
  if (sonarCoverageExclusions.length === 0) {
    return (
      "found no sonar.coverage.exclusions entries in sonar-project.properties — the key is " +
      "missing or the parser is out of step with the file"
    );
  }
  return null;
}

export function checkSonarCoverageParity({
  instrumentedFiles,
  vitestExcludes,
  sonarCoverageExclusions,
  sonarExclusions = [],
}) {
  const floorError = firstFloorError({
    instrumentedFiles,
    vitestExcludes,
    sonarCoverageExclusions,
  });
  if (floorError) {
    return floor(floorError);
  }

  const vitestMatchers = vitestExcludes.map((p) => createPathMatcher(SERVER_PREFIX + p));
  const sonarMatchers = [...sonarCoverageExclusions, ...sonarExclusions].map((pattern) => ({
    pattern,
    matches: createPathMatcher(pattern),
  }));

  const missingFromSonar = [];
  const missingFromVitest = [];
  const hidingPatterns = new Set();

  for (const file of instrumentedFiles) {
    const excludedByVitest = vitestMatchers.some((matches) => matches(file));
    const sonarHit = sonarMatchers.find(({ matches }) => matches(file));
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

/** The candidate set is read off disk, not from `git ls-files`. vitest's coverage `include` is a
 *  filesystem glob, so the files on disk ARE the files it instruments — and reading them needs no
 *  subprocess, which keeps this gate from resolving an executable name through PATH. */
function listServerSourceFiles() {
  const sourceRoot = join(ROOT, "packages", "server", "src");
  if (!existsSync(sourceRoot)) {
    return [];
  }
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

function main() {
  const sonarSource = readFileSync(SONAR_PROPERTIES_PATH, "utf8");
  const vitestSource = readFileSync(VITEST_CONFIG_PATH, "utf8");
  const onDisk = listServerSourceFiles();

  const result = checkSonarCoverageParity({
    instrumentedFiles: selectInstrumentedFiles(onDisk, parseVitestCoverageIncludes(vitestSource)),
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
