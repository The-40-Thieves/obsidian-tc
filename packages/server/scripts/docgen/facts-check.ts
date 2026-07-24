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
//     toolCount from the live registry (extractTools().length), goldenSetSize from
//     docs/project-facts.json. No new source of truth, no third hardcoded 146.
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
 * Pure scan: given a file's text and the fact rules, return every current-fact mismatch, with
 * 1-based line numbers that survive generated-region stripping (marker lines are skipped in place,
 * never collapsed, so line numbers still point at the source). Astro-free and dependency-free so
 * the contract is unit-testable without a build — the same discipline that lets the drift gate be
 * trusted at all.
 */
export function scanFacts(text: string, rules: FactRule[]): FactViolation[] {
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
export function factRules(toolCount: number, goldenSetSize: number): FactRule[] {
  return [
    {
      name: "toolCount",
      value: toolCount,
      // "Full surface" phrasings only. Deliberately NOT bare "(\d+)-tool" (the legitimate "3-tool
      // facade" is a different fact), and "tools across N domains" is anchored to the canonical 31
      // so a milestone sub-count like "20 tools across 9 domains" is not mistaken for the surface.
      patterns: [
        new RegExp(`${STANDALONE}(\\d+)\\s+governed\\s+capabilities`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+tools\\s+across\\s+31\\s+domains`, "i"),
        new RegExp(`${STANDALONE}(\\d+)[-\\s]tool\\s+surface`, "i"),
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
  ];
}

/** Resolve the current facts from the pipeline's authorities and build the rules. */
export function currentFactRules(): FactRule[] {
  const repo = (rel: string): string =>
    fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
  const facts = JSON.parse(readFileSync(repo("docs/project-facts.json"), "utf8")) as {
    goldenSetSize: number;
  };
  return factRules(extractTools().length, facts.goldenSetSize);
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
  return [
    "README.md",
    "ARCHITECTURE.md",
    "SECURITY.md",
    "packages/server/README.md",
    // Top-level docs/ narrative surfaces (NOT under wiki/ or src/content/, so a directory walk
    // misses them — the coverage gap that let "143 tools" survive here).
    "docs/WHY.md",
    "docs/QUICKSTART.md",
    "docs/G2.1-tools.md",
    ...walk("docs/wiki"),
    ...walk("docs/src/content"),
  ];
}

function main(): void {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
  const rules = currentFactRules();
  const all: Array<{ file: string; v: FactViolation }> = [];

  for (const rel of narrativeFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${rel}`, "utf8");
    } catch {
      continue;
    }
    for (const v of scanFacts(text, rules)) all.push({ file: rel, v });
  }

  const counts = rules.map((r) => `${r.name}=${r.value}`).join(", ");
  if (all.length === 0) {
    process.stderr.write(`docgen:facts-check OK — no narrative drift (${counts})\n`);
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
