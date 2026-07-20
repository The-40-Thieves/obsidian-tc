// docgen — eval → docs bridge. Keeps docs/project-facts.json (the curated-facts single source that
// feeds the wiki homepage "At a glance" block) current with the PRIVATE eval harness.
//
// Two facts on the homepage are NOT derivable from this public repo, and this tool treats them
// differently — on purpose:
//   - goldenSetSize      DERIVED. Counted from the private multi-hop golden set (gitignored: it maps
//                        queries to real note paths). The repo can't compute it; this tool can.
//   - enrichmentNdcgGain CURATED. A public claim — the default-on retrieval mechanism's headline
//                        nDCG win. Never auto-scraped from a run (the "current" eval is often an A/B
//                        of something else). You set it explicitly with --enrichment, and only when
//                        a mechanism actually wins its ship gate.
//
// Human-gated: this writes docs/project-facts.json but NEVER commits. These are public-facing
// numbers — review `git diff docs/project-facts.json`, run `bun run docgen:render`, then commit.
//
//   bun scripts/docgen/sync-facts.ts [--golden <path>] [--enrichment "<gain>"] [--check]
//
// --check writes nothing and exits 1 if the file is stale vs the golden set — run it after any
// golden-set change to catch the freshness gap the derived fact exists to close.
//
// Golden set resolution: --golden <path>  >  $OBSIDIAN_TC_GOLDEN  >  eval/multi-hop-golden-set.yaml.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface ProjectFacts {
  _note?: string;
  goldenSetSize: number;
  enrichmentNdcgGain: string;
}

/** Count the golden set's queries. Only asserts a non-empty `queries` array — deliberately NOT
 *  coupled to the full per-query schema (a counter shouldn't break when a query field is added,
 *  and it must work on the minimal committed example too). */
export function countGoldenQueries(yamlText: string): number {
  const doc = parseYaml(yamlText) as { queries?: unknown };
  if (!Array.isArray(doc?.queries) || doc.queries.length === 0) {
    throw new Error("golden set has no non-empty `queries` array");
  }
  return doc.queries.length;
}

/** Pure merge: apply only the fields present in `patch`, preserving everything else (incl. _note). */
export function mergeFacts(
  current: ProjectFacts,
  patch: Partial<Pick<ProjectFacts, "goldenSetSize" | "enrichmentNdcgGain">>,
): ProjectFacts {
  return { ...current, ...patch };
}

/** Serialize in the file's canonical shape: _note, then the facts, 2-space, trailing newline. */
export function serializeFacts(f: ProjectFacts): string {
  const ordered: ProjectFacts = {
    ...(f._note !== undefined ? { _note: f._note } : {}),
    goldenSetSize: f.goldenSetSize,
    enrichmentNdcgGain: f.enrichmentNdcgGain,
  } as ProjectFacts;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const check = argv.includes("--check");
  const enrichment = flag("--enrichment");

  const factsPath = fileURLToPath(new URL("../../../../docs/project-facts.json", import.meta.url));
  const current = JSON.parse(readFileSync(factsPath, "utf8")) as ProjectFacts;

  const patch: Partial<Pick<ProjectFacts, "goldenSetSize" | "enrichmentNdcgGain">> = {};

  // Derived fact: count the golden set if we can find it.
  const goldenPath =
    flag("--golden") ??
    process.env.OBSIDIAN_TC_GOLDEN ??
    fileURLToPath(new URL("../../eval/multi-hop-golden-set.yaml", import.meta.url));
  let goldenText: string | undefined;
  try {
    goldenText = readFileSync(goldenPath, "utf8");
  } catch {
    if (!enrichment) {
      process.stderr.write(
        `sync-facts: golden set not found: ${goldenPath}\n\n` +
          "The golden set is PRIVATE and gitignored (it maps queries to real note paths). Pass its\n" +
          "path with --golden, set $OBSIDIAN_TC_GOLDEN, or keep it at eval/multi-hop-golden-set.yaml.\n" +
          "Schema: packages/server/eval/multi-hop-golden-set.example.yaml.\n" +
          "To update only the curated claim without the golden set, pass --enrichment.\n",
      );
      process.exit(2);
    }
    process.stderr.write(
      `sync-facts: golden set not found (${goldenPath}); skipping goldenSetSize.\n`,
    );
  }
  if (goldenText !== undefined) patch.goldenSetSize = countGoldenQueries(goldenText);

  // Curated fact: only when explicitly supplied.
  if (enrichment !== undefined) patch.enrichmentNdcgGain = enrichment;

  const next = mergeFacts(current, patch);
  const changes: string[] = [];
  if (patch.goldenSetSize !== undefined && patch.goldenSetSize !== current.goldenSetSize)
    changes.push(`  goldenSetSize:      ${current.goldenSetSize} → ${next.goldenSetSize}`);
  if (
    patch.enrichmentNdcgGain !== undefined &&
    patch.enrichmentNdcgGain !== current.enrichmentNdcgGain
  )
    changes.push(
      `  enrichmentNdcgGain: ${current.enrichmentNdcgGain} → ${next.enrichmentNdcgGain}`,
    );

  if (changes.length === 0) {
    process.stdout.write("sync-facts: docs/project-facts.json already current.\n");
    process.exit(0);
  }

  process.stdout.write(`sync-facts: proposed changes:\n${changes.join("\n")}\n`);
  if (check) {
    process.stderr.write(
      "sync-facts: STALE — run `bun run docgen:sync-facts` (drop --check) to apply.\n",
    );
    process.exit(1);
  }
  writeFileSync(factsPath, serializeFacts(next));
  process.stdout.write(
    "\nsync-facts: wrote docs/project-facts.json. Next:\n" +
      "  1. bun run docgen:render        # propagate into the wiki/Astro pages\n" +
      "  2. git diff docs/wiki/ docs/project-facts.json   # review the public-facing change\n" +
      "  3. commit — merging republishes the wiki via ci-wiki\n",
  );
}
