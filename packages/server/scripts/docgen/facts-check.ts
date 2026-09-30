// docgen — narrative fact assert gate (THE-566 / THE-470). The complement to `injectGenerated`
// (render.ts), which owns facts INSIDE `<!-- GENERATED -->` regions.
//
// It is the NEGATIVE sweep: scan every narrative surface for a fact-shaped number typed by a human
// outside a generated region, and fail on it. Two kinds of fact:
//
//   * CURRENT facts that change rarely and are curated in docs/project-facts.json (goldenSetSize,
//     domainCount): an occurrence must equal the canonical value.
//   * The TOOL COUNT, which changes with every tool-adding PR: NO occurrence is allowed at all.
//     A correct "167 tools" in prose is stale by the next tool PR, and keeping ~22 such sites current
//     made every two tool-adding PRs conflict on them (and once both wrote the same new number,
//     merge to a count that was wrong by one). Prose states no count — say "every tool", "the full
//     surface" — and the number lives only in generated regions (docgen:render fills the stats
//     block and tool catalog at build time from the live registry).
//
// This replaces two earlier mechanisms: the equality check against the registry count, and
// check-version-coherence.mjs's ~10 positive anchors ("this exact phrase must exist and equal N").
// Both existed to keep typed counts current; with no typed counts there is nothing to keep current,
// and a positive anchor on a phrase that must no longer exist would only force the number back in.
//
// Two escape hatches keep it honest about intent (the reason THE-566 was a decision, not a sed):
//   * genuinely-historical or spec numbers (the real "3-tool facade", the "103 at r2" G2.1 design
//     surface, a dated measurement) are NOT current facts — mark that line `<!-- facts-check:ignore -->`
//     (or the whole file `<!-- facts-check:ignore-file -->`) and the sweep skips it.
//   * goldenSetSize and domainCount are asserted against docs/project-facts.json, the one curated
//     authority (they come from the private eval harness / the G2.1 design-era domain list, not a
//     single live registry structure).
//
//   bun scripts/docgen/facts-check.ts            # report + exit 1 on drift
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A tracked, machine-checkable CURRENT fact and the patterns that mean it in prose. */
export interface FactRule {
  name: string;
  /** The canonical value an occurrence must equal, or `null` = NO occurrence is allowed (the tool
   *  count: prose must not state it at all). */
  value: number | null;
  /** Patterns whose first capture group is the number that must equal `value`. */
  patterns: RegExp[];
  /** When set, a pattern only applies to lines that also match this (proximity scoping). */
  onLineMatching?: RegExp;
}

export interface FactViolation {
  fact: string;
  line: number;
  found: number;
  /** `null` for a forbidden fact: any occurrence is the violation. */
  expected: number | null;
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
          if (!Number.isFinite(found) || (rule.value !== null && found === rule.value)) continue;
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
export function factRules(goldenSetSize: number, domainCount: number): FactRule[] {
  return [
    {
      name: "toolCount",
      // Forbidden outright — see the header. The patterns are the "full surface" phrasings seen in
      // the wild; each one was added for an observed leak.
      value: null,
      patterns: [
        new RegExp(`${STANDALONE}(\\d+)\\s+governed\\s+capabilities`, "i"),
        // SKILLS.md said "143 capabilities across 31 domains" and "143 tools / 31 domains" for a
        // while after the real surface moved on; the file was not swept and the phrasings did not
        // match. Three-plus digits keeps "3 capabilities" style sub-counts legal.
        new RegExp(`${STANDALONE}(\\d{3,})\\s+capabilities\\s+across`, "i"),
        new RegExp(`${STANDALONE}(\\d{3,})\\s+tools\\s*/\\s*\\d+\\s+domains`, "i"),
        // Three-plus digits: a milestone sub-count ("20 tools across 9 domains") is a different,
        // legitimate fact, and no tool surface has been under 100 since 1.3.
        new RegExp(`${STANDALONE}(\\d{3,})\\s+tools\\s+across\\s+\\d+\\s+domains`, "i"),
        new RegExp(`${STANDALONE}(\\d+)[-\\s]tool\\s+surface`, "i"),
        // THE-598: "the 128-tool G2.1 set plus post-1.0 additive tools" (ARCHITECTURE.md) slipped
        // through every gate — one noun away from the pattern above. Matches an arbitrary noun
        // between the count and a closing "surface"/"set" (e.g. "128-tool G2.1 set").
        new RegExp(`${STANDALONE}(\\d+)-tool\\s+\\S+\\s+(?:surface|set)`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+typed\\s+tools`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+tool\\s+impls?`, "i"), // "across the 141 tool impls"
        // Measured 2026-07-31: "150 tools" survived in FIVE places while the registry said 151.
        // A bare `(\\d+)\\s+tools\\b` is WRONG here: the gate's tests pin "the facade fronts the
        // surface with 3 tools" and "20 tools across 9 domains" as must-NOT-flag, and nothing but
        // magnitude separates them from "150 tools". So these stay narrow, one per observed leak.
        new RegExp(`${STANDALONE}(\\d+)\\s+tools\\s+covering`, "i"),
        new RegExp(`${STANDALONE}(\\d+)\\s+tools\\s+ship`, "i"),
        /\ball\s+(\d+)\s+tools\b/i,
        new RegExp(`${STANDALONE}(\\d+)\\s+tools\\s+across\\s+modules`, "i"),
        // The opt-in core profile's count moves with the same PRs ("97 with opt-in profile: core").
        new RegExp(`${STANDALONE}(\\d+)\\s+(?:tools\\s+)?with\\s+the\\s+opt-in\\s+\`profile`, "i"),
        /\((?:all\s+visible\s+by\s+default;\s+)?(\d+)\s+with\s+opt-in\s+`profile/i,
        /(?:^|[\s(*~])~?(\d{3,})\s+\(3-tool\s+facade\)/i,
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
    // THE-470 hole 3: "31 domains" was only ever an ANCHOR — never itself asserted, so it could
    // drift to 32 silently everywhere it appears. Anchored on a three-digit tool count so a
    // milestone line like "20 tools across 9 domains" (a real, smaller sub-count) is not mistaken
    // for the canonical figure.
    {
      name: "domainCount",
      value: domainCount,
      patterns: [new RegExp(`${STANDALONE}\\d{3,}\\s+tools\\s+across\\s+(\\d+)\\s+domains`, "i")],
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
  return factRules(facts.goldenSetSize, facts.domainCount);
}

/**
 * Narrative surfaces to sweep. Generated regions inside them are stripped by scanFacts.
 *
 * Exported for check-error-envelope.ts (THE-470), which sweeps the same corpus for a different
 * class of restated fact. One definition of "the narrative surfaces" — a second walk would drift
 * from this one exactly the way render.ts's target list drifted from suggest-prose.ts's, which is
 * why targets.ts exists.
 */
export function narrativeFiles(repoRoot: string): string[] {
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
    // Agent-facing guide, shipped in the package; it restated the surface size in three places.
    "SKILLS.md",
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
 * The numbers are floors, not targets. Measured on `main` at the time of writing: **54 files, ~7800
 * narrative lines, 6 pattern matches** (golden-set phrasings; the forbidden tool-count rule matches
 * nothing by design) — so each floor sits well under reality, leaving room for ordinary doc churn
 * while still catching a broken walk or an unreadable tree. The CANARIES above are what prove the
 * forbidden rule itself still fires.
 */
const FLOOR = { files: 20, lines: 500, patternMatches: 3 } as const;

/**
 * Canary for the forbidden tool-count rule. In a clean tree that rule matches NOTHING (that is the
 * goal), so a pattern-match floor can no longer prove it is still capable of firing — a regex
 * edited into a no-op would keep the gate green forever. Planting a phrase per pattern shape and
 * requiring the rule to flag each one is the existence floor for a gate whose success is silence.
 */
const CANARIES = [
  "the 999-tool surface",
  "999 governed capabilities",
  "999 capabilities across 31 domains",
  "the surface is 999 tools / 31 domains",
  "999 tools across 31 domains",
  "the 999-tool G2.1 set",
  "999 typed tools",
  "across the 999 tool impls",
  "all 999 tools",
  '999 with the opt-in `profile: "core"`',
] as const;

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

  const counts = rules.map((r) => `${r.name}=${r.value ?? "forbidden"}`).join(", ");

  const toolRule = rules.find((r) => r.name === "toolCount");
  const deadCanaries = CANARIES.filter((c) => !toolRule || scanFacts(c, [toolRule]).length === 0);

  const shortfalls = [
    deadCanaries.length > 0 &&
      `the tool-count rule no longer flags ${deadCanaries.length} canary phrase(s): ${deadCanaries.join(" | ")}`,
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
      `  ${file}:${v.line}  ${v.fact} — found ${v.found} in "${v.snippet}", ` +
        `${v.expected === null ? "expected no count here (say 'every tool' / 'the full surface'; the number lives in generated regions)" : `expected ${v.expected}`}\n`,
    );
  }
  process.stderr.write(
    `\nFix the stale number, OR mark the line <!-- ${IGNORE_LINE} --> if it is an intentional ` +
      `historical/spec value (e.g. the 3-tool facade, a dated measurement).\n`,
  );
  process.exit(1);
}

if ((import.meta as unknown as { main?: boolean }).main) main();
