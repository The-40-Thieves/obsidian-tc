// docgen — narrative fact assert gate (THE-566 / THE-470). The complement to two existing checks:
//
//   * `injectGenerated` (render.ts) owns facts INSIDE `<!-- GENERATED -->` markers — byte-exact.
//   * `check-version-coherence.mjs` (THE-306) POSITIVELY asserts a fixed allowlist of 9 canonical
//     tool-count phrases: "this exact phrase must exist and equal N".
//
// Neither can see a fact-shaped number that a human typed into narrative OUTSIDE a marker and
// OUTSIDE the allowlist — which is exactly how "143 tools" leaked into docs/wiki/Home.md, WHY.md,
// QUICKSTART.md, G2.1-tools.md, and how "n=136 golden set" survived across README/wiki/roadmap
// after the set grew to 250. This gate is the NEGATIVE sweep: scan every narrative surface and fail
// if any occurrence of a tracked current fact disagrees with its canonical value.
//
// Two escape hatches keep it honest about intent (the reason THE-566 was a decision, not a sed):
//   * genuinely-historical or spec numbers (the real "3-tool facade", the "103 at r2" G2.1 design
//     surface, a dated measurement) are NOT current facts — mark that line `<!-- facts-check:ignore -->`
//     (or the whole file `<!-- facts-check:ignore-file -->`) and the sweep skips it.
//   * a fact is only ever asserted against the ONE authority the render pipeline already trusts:
//     toolCount from the live registry (extractTools().length), goldenSetSize and domainCount
//     (THE-470 hole 3) from docs/project-facts.json. No new source of truth, no third hardcoded
//     146 — and no fourth hardcoded 31: the domain map (src/mcp/facade.ts) only covers 13
//     tool-routing buckets, not the "31 domains" figure, which spans the G2.1 design-era domain
//     list plus post-1.0 additions and so is curated exactly like goldenSetSize.
//
//   bun scripts/docgen/facts-check.ts            # report + exit 1 on drift
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractTools } from "./extract-tools";

/** A tracked, machine-checkable CURRENT fact and the patterns that mean it in prose. */
export interface FactRule {
  name: string;
  value: number;
  /** Patterns whose first capture group is the number that must equal `value`. */
  patterns: RegExp[];
  /** When set, a pattern only applies to lines that also match this (proximity scoping). */
  onLineMatching?: RegExp;
}

export interface FactViolation {
  fact: string;
  line: number;
  found: number;
  expected: number;
  snippet: string;
}

const IGNORE_LINE = "facts-check:ignore";
const IGNORE_FILE = "facts-check:ignore-file";

/**
 * THE-601: what the scan actually DID, as opposed to what it found.
 *
 * A fact gate reports success by finding nothing, so "found nothing" and "looked at nothing" are
 * the same output. These counters are what tell them apart — see the floors in main().
 */
export interface ScanStats {
  /** Narrative lines examined (generated regions and ignore-marked lines excluded). */
  linesScanned: number;
  /** Times a rule pattern MATCHED — whether or not the value it captured was wrong. This is the
   *  load-bearing one: it is the only evidence a rule is capable of firing at all. */
  patternMatches: number;
}

/**
 * Pure scan: given a file's text and the fact rules, return every current-fact mismatch, with
 * 1-based line numbers that survive generated-region stripping (marker lines are skipped in place,
 * never collapsed, so line numbers still point at the source). Astro-free and dependency-free so
 * the contract is unit-testable without a build — the same discipline that lets the drift gate be
 * trusted at all.
 *
 * `stats`, when passed, accumulates what the scan examined (THE-601). Optional so every existing
 * caller and the pure unit tests are unaffected.
 */
export function scanFacts(text: string, rules: FactRule[], stats?: ScanStats): FactViolation[] {
  if (text.includes(IGNORE_FILE)) return [];
  const violations: FactViolation[] = [];
  let inGenerated = false;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Toggle on marker lines; the marker lines themselves are not narrative.
    if (line.includes("<!-- BEGIN GENERATED:")) {
      inGenerated = true;
      continue;
    }
    if (line.includes("<!-- END GENERATED:")) {
      inGenerated = false;
      continue;
    }
    if (inGenerated) continue;
    if (line.includes(IGNORE_LINE)) continue;
    if (stats) stats.linesScanned += 1;

    for (const rule of rules) {
      if (rule.onLineMatching && !rule.onLineMatching.test(line)) continue;
      for (const pattern of rule.patterns) {
        // Fresh regex per line so lastIndex state never leaks across lines.
        const re = new RegExp(
          pattern.source,
          pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
        );
        for (const m of line.matchAll(re)) {
          const found = Number(m[1]);
          // Counted BEFORE the value comparison, deliberately. A match whose number is CORRECT is
          // still proof the rule can fire — and in a clean tree that is the only kind of match
          // there is, so counting only violations would make the floor unsatisfiable exactly when
          // the docs are right.
          if (Number.isFinite(found) && stats) stats.patternMatches += 1;
          if (!Number.isFinite(found) || found === rule.value) continue;
          violations.push({
            fact: rule.name,
            line: i + 1,
            found,
            expected: rule.value,
            snippet: (m[0] ?? "").trim(),
          });
        }
      }
    }
  }
  return violations;
}

// A number embedded in a token (THE-135, G2.1, r2, V1, M4, a hyphenated range) is NOT a fact —
// this negative lookbehind requires the captured number to be a standalone word, which kills the
// whole class of false positive the dry run surfaced ("G2.1 tool surface" → "1", "THE-135 query"
// → "135", "r2 tool surface" → "2").
const STANDALONE = "(?<![A-Za-z0-9.\\-])";

/**
 * The tracked current facts, as a PURE function of their values — no filesystem, no registry — so
 * the exact production patterns are unit-testable. `currentFactRules()` resolves the values from
 * the render pipeline's own authorities and calls this.
 */
export function factRules(
  toolCount: number,
  goldenSetSize: number,
  domainCount: number,
): FactRule[] {
  return [
    {
      name: "toolCount",
      value: toolCount,
      // "Full surface" phrasings only. Deliberately NOT bare "(\d+)-tool" (the legitimate "3-tool
      // facade" is a different fact). "tools across N domains" is anchored to the CURRENT
      // domainCount (not a hardcoded 31) so a milestone sub-count like "20 tools across 9 domains"
      // is not mistaken for the surface, and the anchor tracks domainCount as it changes.
      patterns: [
        new RegExp(`${STANDALONE}(\\d+)\\s+governed\\s+capabilities`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+tools\\s+across\\s+${domainCount}\\s+domains`, "i"),
        new RegExp(`${STANDALONE}(\\d+)[-\\s]tool\\s+surface`, "i"),
        // THE-598: "the 128-tool G2.1 set plus post-1.0 additive tools" (ARCHITECTURE.md) slipped
        // through every gate — one noun away from the pattern above, which requires "tool" to be
        // followed directly by "surface". Widened to also match an arbitrary noun between the
        // count and a closing "surface"/"set" (e.g. "128-tool G2.1 set", "146-tool registered
        // surface"), without touching the "-tool surface" pattern's own STANDALONE-anchored count
        // group.
        new RegExp(`${STANDALONE}(\\d+)-tool\\s+\\S+\\s+(?:surface|set)`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+typed\\s+tools`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+tool\\s+impls?`, "i"), // "across the 141 tool impls"
      ],
    },
    {
      name: "goldenSetSize",
      value: goldenSetSize,
      onLineMatching: /golden[-\s]set/i, // "golden set" or "golden-set"; unrelated "n=" is skipped
      patterns: [
        new RegExp(`${STANDALONE}n\\s*=\\s*(\\d+)`, "i"),
        new RegExp(`${STANDALONE}(\\d+)[-\\s]quer(?:y|ies)[-\\s]golden`, "i"),
      ],
    },
    // THE-470 hole 3: "31 domains" was only ever an ANCHOR inside the toolCount pattern above (and
    // in scripts/check-version-coherence.mjs) — never itself asserted, so it could drift to 32
    // silently everywhere it appears. Anchored on the canonical toolCount, mirroring how the
    // toolCount rule anchors on domainCount above, so a milestone line like "20 tools across 9
    // domains" (a real, different, smaller sub-count) is not mistaken for the canonical figure.
    {
      name: "domainCount",
      value: domainCount,
      patterns: [
        new RegExp(`${STANDALONE}${toolCount}\\s+tools\\s+across\\s+(\\d+)\\s+domains`, "i"),
      ],
    },
  ];
}

/** Resolve the current facts from the pipeline's authorities and build the rules. */
export function currentFactRules(): FactRule[] {
  const repo = (rel: string): string =>
    fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
  const facts = JSON.parse(readFileSync(repo("docs/project-facts.json"), "utf8")) as {
    goldenSetSize: number;
    domainCount: number;
  };
  return factRules(extractTools().length, facts.goldenSetSize, facts.domainCount);
}

/** Narrative surfaces to sweep. Generated regions inside them are stripped by scanFacts. */
function narrativeFiles(repoRoot: string): string[] {
  const rooted = (rel: string) => `${repoRoot}/${rel}`;
  const walk = (relDir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(rooted(relDir), { recursive: true }) as string[];
    } catch {
      return [];
    }
    return entries
      .filter((e) => /\.(md|mdx)$/i.test(e) && !e.includes("node_modules"))
      .map((e) => `${relDir}/${e}`);
  };
  // THE-598: top-level docs/*.md used to be three hand-picked names (WHY.md, QUICKSTART.md,
  // G2.1-tools.md) — a fourth hardcoded list alongside narrativeFiles' own recursive walks below,
  // and the reason docs/G2.4-observability.md (home of the worst config-key drift cluster) was in
  // NEITHER this gate nor check-version-coherence.mjs. A non-recursive listing of docs/ itself
  // covers every current and future top-level design doc without another name to remember; it
  // deliberately does NOT recurse (docs/wiki and docs/src/content are already walked separately
  // below, each with their own generated-region conventions).
  const topLevelDocs = (): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(rooted("docs"), { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(md|mdx)$/i.test(e.name))
        .map((e) => `docs/${e.name}`);
    } catch {
      return [];
    }
    return entries;
  };
  return [
    "README.md",
    "ARCHITECTURE.md",
    "SECURITY.md",
    // THE-623: CONTRIBUTING.md was outside every prose gate, and drifted — it claimed 19 required
    // checks (live: 26) and that the test suite COULD NOT be required, a year after THE-599 made it
    // required. An external reviewer read it, reasoned correctly from it, and recommended rebuilding
    // a workaround that no longer had a problem to solve. It carries no anchored fact today; it is
    // listed so that the next tool-count or golden-set number written here is caught the same day.
    "CONTRIBUTING.md",
    "packages/server/README.md",
    ...topLevelDocs(),
    ...walk("docs/wiki"),
    ...walk("docs/src/content"),
  ];
}

/**
 * THE-601 floors. A gate that reports success by finding nothing is indistinguishable from a gate
 * that looked at nothing, so these are the numbers that have to be non-zero for "OK" to mean
 * anything.
 *
 * This is not hypothetical. `repoRoot` is a four-level relative climb from `import.meta.url`, and
 * `bun --compile` BAKES `import.meta.url` at build time — the exact mechanism that has already
 * shipped two broken releases from this repo. Every read in this file is wrapped in
 * `try { … } catch { continue }`, so a mis-resolved root does not throw; it silently scans zero
 * files and prints "OK — no narrative drift".
 *
 * The sibling gates already refuse this. render.ts throws on a zero-marker scan ("the scan is
 * broken, not the docs. Refusing to report success"), has a second floor on metric mentions, and
 * gen-tree-map.mjs refuses an empty file list. facts-check was the one that missed it.
 *
 * The numbers are floors, not targets. Measured on `main` at the time of writing: **54 files, 7817
 * narrative lines, 30 pattern matches** — so each floor sits at roughly a third of reality, leaving
 * room for ordinary doc churn (and for deleting a doc or two) while still catching a broken walk,
 * an unreadable tree, or a rule set that can no longer match anything.
 *
 * `patternMatches` is the tightest of the three at 30, and deliberately so: it is the only one that
 * fails if the RULES stop working while the files are still readable — e.g. a `domainCount` change
 * silently invalidating the "tools across N domains" anchor.
 */
const FLOOR = { files: 20, lines: 500, patternMatches: 10 } as const;

function main(): void {
  // The override exists so the FLOOR can be watched failing end-to-end, which is the only way to
  // trust it (reference-source-scan-gates rule 3). It is safe by construction: it can only change
  // WHERE the scan looks, and pointing it anywhere without docs makes the gate FAIL — never pass.
  // There is no setting of this variable that turns a red run green.
  const repoRoot =
    process.env.DOCGEN_FACTS_ROOT_OVERRIDE ??
    fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
  const rules = currentFactRules();
  const all: Array<{ file: string; v: FactViolation }> = [];
  const stats: ScanStats = { linesScanned: 0, patternMatches: 0 };
  let filesRead = 0;

  for (const rel of narrativeFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${rel}`, "utf8");
    } catch {
      continue;
    }
    // Counted on a successful READ, not on the listing: a walk that returns names for files that
    // cannot then be opened is the same failure wearing a different hat.
    filesRead += 1;
    for (const v of scanFacts(text, rules, stats)) all.push({ file: rel, v });
  }

  const counts = rules.map((r) => `${r.name}=${r.value}`).join(", ");

  const shortfalls = [
    filesRead < FLOOR.files && `read ${filesRead} narrative files (floor ${FLOOR.files})`,
    stats.linesScanned < FLOOR.lines &&
      `scanned ${stats.linesScanned} narrative lines (floor ${FLOOR.lines})`,
    stats.patternMatches < FLOOR.patternMatches &&
      `matched ${stats.patternMatches} fact patterns (floor ${FLOOR.patternMatches})`,
  ].filter((s): s is string => typeof s === "string");

  if (shortfalls.length > 0) {
    process.stderr.write(
      `\nFAIL: docgen:facts-check scanned too little to report success (THE-601).\n` +
        `${shortfalls.map((s) => `  - ${s}\n`).join("")}` +
        `\nThis is the GATE being broken, not the docs. Most likely repoRoot resolved wrong\n` +
        `(resolved: ${repoRoot}) — every read here is wrapped in a catch, so a bad root scans\n` +
        `zero files and would otherwise print OK. Refusing to report success.\n`,
    );
    process.exit(1);
  }

  if (all.length === 0) {
    process.stderr.write(
      `docgen:facts-check OK — no narrative drift (${counts}); ` +
        `${filesRead} files, ${stats.linesScanned} lines, ${stats.patternMatches} pattern matches\n`,
    );
    return;
  }
  process.stderr.write(`\nFAIL: narrative fact drift (THE-566), current facts: ${counts}\n`);
  for (const { file, v } of all) {
    process.stderr.write(
      `  ${file}:${v.line}  ${v.fact} — found ${v.found} in "${v.snippet}", expected ${v.expected}\n`,
    );
  }
  process.stderr.write(
    `\nFix the stale number, OR mark the line <!-- ${IGNORE_LINE} --> if it is an intentional ` +
      `historical/spec value (e.g. the 3-tool facade, a dated measurement).\n`,
  );
  process.exit(1);
}

if ((import.meta as unknown as { main?: boolean }).main) main();
