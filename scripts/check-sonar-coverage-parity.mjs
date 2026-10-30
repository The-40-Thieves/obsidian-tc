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
 *     rather than how well the server is tested — the exact failure the exclusions list exists to
 *     prevent.
 *   - A packages/server/src file excluded in Sonar but NOT in vitest is the worse one: vitest does
 *     instrument it, so Sonar is hiding real measured coverage and the quality gate reads a
 *     smaller, friendlier denominator than the suite actually produced.
 *
 * The comparison is pattern-aware, not a literal diff. vitest's patterns are relative to
 * packages/server; Sonar's are repository-relative, so each vitest entry is prefixed before
 * matching. A vitest glob counts as covered when a representative path matching it is matched by
 * any Sonar pattern — which is how `src/**` + `/*.d.ts` passes on the strength of the repo-wide
 * `**` + `/*.d.ts` in sonar.exclusions, without demanding a literal copy in the coverage list.
 *
 * Only packages/server/src entries are checked in the Sonar-to-vitest direction: vitest's coverage
 * `include` is src/**, so scripts/, docs/, test/ and the other workspaces are uninstrumented by
 * construction and have no vitest counterpart to match.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SONAR_PROPERTIES_PATH = join(ROOT, "sonar-project.properties");
export const VITEST_CONFIG_PATH = join(ROOT, "packages", "server", "vitest.config.ts");

/** vitest patterns are relative to packages/server; Sonar's are relative to the repository root. */
export const SERVER_PREFIX = "packages/server/";

/** Reads the `exclude` array belonging to the `coverage` block specifically — `test.exclude` is a
 *  different list with a different job, and reading it instead would compare the wrong thing. */
export function parseVitestCoverageExcludes(source) {
  const coverageAt = source.indexOf("coverage:");
  if (coverageAt === -1) {
    return [];
  }
  const match = source.slice(coverageAt).match(/\bexclude\s*:\s*\[([^\]]*)\]/);
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
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

/** Sonar path-matcher semantics: `**` spans directories, `*` stays inside one segment. */
function sonarPatternToRegExp(pattern) {
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

/** One concrete path that the glob would match, so "is this pattern covered?" becomes the much
 *  simpler "is this path excluded?". Placeholder segments cannot collide with a real name. */
export function representativePath(pattern) {
  return pattern
    .replace(/\*\*/g, "\u0000G")
    .replace(/\*/g, "\u0000S")
    .replace(/\u0000G/g, "globdir")
    .replace(/\u0000S/g, "globseg");
}

export function checkSonarCoverageParity({
  vitestExcludes,
  sonarCoverageExclusions,
  sonarExclusions = [],
}) {
  // A gate that scans nothing reports success, so both inputs carry a non-empty floor: an empty
  // list here means the parse broke, not that the repo is clean.
  if (vitestExcludes.length === 0) {
    return {
      ok: false,
      parseError:
        "found no coverage.exclude entries in packages/server/vitest.config.ts — the parser is " +
        "out of step with the config's shape, not the config with Sonar",
      missingFromSonar: [],
      missingFromVitest: [],
    };
  }
  if (sonarCoverageExclusions.length === 0) {
    return {
      ok: false,
      parseError:
        "found no sonar.coverage.exclusions entries in sonar-project.properties — the key is " +
        "missing or the parser is out of step with the file",
      missingFromSonar: [],
      missingFromVitest: [],
    };
  }

  const matchers = [...sonarCoverageExclusions, ...sonarExclusions].map(sonarPatternToRegExp);
  const missingFromSonar = [];
  for (const entry of vitestExcludes) {
    const repoRelative = SERVER_PREFIX + entry;
    const probe = representativePath(repoRelative);
    if (!matchers.some((re) => re.test(probe))) {
      missingFromSonar.push(repoRelative);
    }
  }

  const vitestSet = new Set(vitestExcludes);
  const missingFromVitest = [];
  for (const entry of sonarCoverageExclusions) {
    if (!entry.startsWith(`${SERVER_PREFIX}src/`)) {
      continue;
    }
    if (!vitestSet.has(entry.slice(SERVER_PREFIX.length))) {
      missingFromVitest.push(entry);
    }
  }

  return {
    ok: missingFromSonar.length === 0 && missingFromVitest.length === 0,
    parseError: null,
    missingFromSonar,
    missingFromVitest,
  };
}

function main() {
  const sonarSource = readFileSync(SONAR_PROPERTIES_PATH, "utf8");
  const result = checkSonarCoverageParity({
    vitestExcludes: parseVitestCoverageExcludes(readFileSync(VITEST_CONFIG_PATH, "utf8")),
    sonarCoverageExclusions: parseSonarProperty(sonarSource, "sonar.coverage.exclusions"),
    sonarExclusions: parseSonarProperty(sonarSource, "sonar.exclusions"),
  });

  if (result.ok) {
    console.log(
      "check-sonar-coverage-parity: OK — every vitest coverage exclude is excluded in Sonar, " +
        "and Sonar hides no packages/server/src file that vitest instruments.",
    );
    process.exit(0);
  }

  if (result.parseError) {
    console.error(`check-sonar-coverage-parity: ${result.parseError}.`);
    process.exit(1);
  }

  if (result.missingFromSonar.length > 0) {
    console.error(
      "check-sonar-coverage-parity: excluded from vitest coverage but not from Sonar — Sonar " +
        "will score these 0% although nothing instruments them. Add them to " +
        "sonar.coverage.exclusions in sonar-project.properties:",
    );
    for (const entry of result.missingFromSonar) {
      console.error(`  ${entry}`);
    }
  }

  if (result.missingFromVitest.length > 0) {
    console.error(
      "check-sonar-coverage-parity: excluded from Sonar but still instrumented by vitest — Sonar " +
        "is hiding coverage the suite actually measured. Either drop them from " +
        "sonar.coverage.exclusions, or exclude them in packages/server/vitest.config.ts too if " +
        "they genuinely hold no testable logic:",
    );
    for (const entry of result.missingFromVitest) {
      console.error(`  ${entry}`);
    }
  }
  process.exit(1);
}

// Importing this module (as its test file does) must have no side effects — no filesystem reads,
// no process.exit. Only run the gate when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
