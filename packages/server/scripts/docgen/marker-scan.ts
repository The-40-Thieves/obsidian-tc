// docgen — generated-marker scanner (THE-470 hole 1). render.ts's existing guard is
// one-directional: it fails when a render TARGET forgets to declare itself in targets.ts, but it
// has no way to notice a marker that exists in a doc with NO renderer at all — exactly how
// docs/wiki/Plugin-Bridges.md's `bridge-compat` table sat unrendered for months, invisible to
// docgen:render, the drift gate, and the prose watcher, and asserted only by a standalone vitest
// test that happened to check the numbers.
//
// This walks the doc surfaces docgen owns and returns every `<!-- BEGIN GENERATED: name -->`
// marker actually present, so render.ts can fail when one has no matching target. Scoped to the
// same surfaces as GENERATED_DOC_FILES (README.md, ARCHITECTURE.md, docs/wiki, docs/src/content,
// docs/*.md) — TREE.md's marker regions are a different generator (scripts/gen-tree-map.mjs /
// `bun run map:check`, wired into ci-docgen.yml separately) and are out of scope here.
import { readdirSync, readFileSync } from "node:fs";

const MARKER_RE = /<!-- BEGIN GENERATED: ([\w-]+) -->/g;

function walk(repoRoot: string, relDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(`${repoRoot}/${relDir}`, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries.filter((e) => /\.mdx?$/i.test(e)).map((e) => `${relDir}/${e}`);
}

/** Top-level `*.md`/`*.mdx` files directly inside `relDir` — non-recursive, so it does not also
 *  pick up files already covered by a nested `walk()` root. */
function walkTopLevel(repoRoot: string, relDir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(`${repoRoot}/${relDir}`, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.mdx?$/i.test(e.name))
    .map((e) => `${relDir}/${e.name}`);
}

/** repo-relative doc surfaces docgen scans for marker pairs. Exported so the case-(c)
 *  hand-written-catalog scan (THE-595) shares the exact same surface rather than drifting from it
 *  the way GENERATED_DOC_FILES/suggest-prose.ts once did (see targets.ts's header comment). */
export function candidateFiles(repoRoot: string): string[] {
  return [
    "README.md",
    "ARCHITECTURE.md",
    ...walk(repoRoot, "docs/wiki"),
    ...walk(repoRoot, "docs/src/content"),
    // THE-595: docs/*.md (the G2 design-doc surface) — top-level only, non-recursive, so this
    // does NOT re-walk docs/wiki or docs/src (already covered above) and does NOT pick up
    // TREE.md, which lives at the repo root and is gated separately by `map:check`.
    ...walkTopLevel(repoRoot, "docs"),
  ];
}

export interface DiscoveredMarker {
  file: string;
  marker: string;
}

/**
 * Every `<!-- BEGIN GENERATED: name -->` marker found across docgen's doc surfaces, as
 * `{ file, marker }` pairs. A caller must treat an empty result as a FAILURE, not a clean scan —
 * a broken glob/path reads exactly like "no generated docs exist", which is the same class of
 * silent-empty-scan bug that has bitten this repo's other gates before.
 */
export function findGeneratedMarkers(repoRoot: string): DiscoveredMarker[] {
  const out: DiscoveredMarker[] = [];
  for (const rel of candidateFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${rel}`, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(MARKER_RE)) {
      const marker = m[1];
      if (marker) out.push({ file: rel, marker });
    }
  }
  return out;
}
