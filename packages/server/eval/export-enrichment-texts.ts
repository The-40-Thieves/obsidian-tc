// THE-440 — export the embed-TEXTS for a GPU nomic embedding pass (Cave is CPU-bound, ~1 embed/s).
// Emits three files so control + variant share ONE embedder (a fair A/B — only the text differs):
//   docs_control.jsonl   {chunk_id, text}  THE-406 plain enrichment (title + heading breadcrumb)
//   docs_variant.jsonl   {chunk_id, text}  + 1-hop graph-neighbor "linked notes:" line
//   queries.jsonl        {id, text}        the golden queries (query side)
//
// Usage: bun eval/export-enrichment-texts.ts <config.json> <golden.yaml> <outdir> [--cap N] [--variant titles|titles-headings]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { enrichChunkText } from "../src/search/chunk";
import { GoldenSetSchema } from "./metrics";

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const [configPath, goldenPath, outDir] = pos;
const capIdx = argv.indexOf("--cap");
const CAP = capIdx >= 0 ? Number(argv[capIdx + 1]) : 12;
const vIdx = argv.indexOf("--variant");
const VARIANT = (vIdx >= 0 ? argv[vIdx + 1] : "titles") as "titles" | "titles-headings";
if (!configPath || !goldenPath || !outDir) {
  process.stderr.write(
    "usage: bun eval/export-enrichment-texts.ts <config.json> <golden.yaml> <outdir> [--cap N] [--variant titles|titles-headings]\n",
  );
  process.exit(2);
}

const titleOf = (p: string): string => (p.split(/[/\\]/).pop() ?? p).replace(/\.md$/i, "");

async function main(): Promise<void> {
  const config = loadConfig(configPath as string);
  const vault = config.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const db = await openDatabase(join(config.cacheDir, "cache.db"));

  const edges = db
    .prepare(
      "SELECT source_path AS s, target_path AS t FROM vault_edges WHERE vault_id = ? AND edge_type = 'links_to'",
    )
    .all(vault.id) as Array<{ s: string; t: string }>;
  const neigh = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    if (a === b) return;
    let set = neigh.get(a);
    if (!set) {
      set = new Set<string>();
      neigh.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    add(e.s, e.t);
    add(e.t, e.s);
  }

  const chunks = db
    .prepare(
      "SELECT id, path, headings, content FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
    )
    .all(vault.id) as Array<{ id: string; path: string; headings: string; content: string }>;

  // variant-b: per-note distinct level-1 section headings (headings[1]; headings[0] is the note
  // title). Gives a neighbor's STRUCTURE, not just its title. Capped per neighbor when rendered.
  const sectionsForNote = new Map<string, string[]>();
  for (const c of chunks) {
    try {
      const h = JSON.parse(c.headings) as string[];
      const sec = h[1];
      if (sec) {
        const cur = sectionsForNote.get(c.path) ?? [];
        if (!cur.includes(sec)) sectionsForNote.set(c.path, [...cur, sec]);
      }
    } catch {
      // no headings for this chunk
    }
  }

  const controlLines: string[] = [];
  const variantLines: string[] = [];
  for (const c of chunks) {
    let headings: string[] = [];
    try {
      headings = JSON.parse(c.headings) as string[];
    } catch {
      headings = [];
    }
    const base = enrichChunkText(c.path, headings, c.content);
    controlLines.push(JSON.stringify({ chunk_id: c.id, text: base }));

    const nbrPaths = [...(neigh.get(c.path) ?? [])].sort().slice(0, CAP);
    let variantText = base;
    if (nbrPaths.length > 0) {
      // variant-a "titles": just the neighbor note titles. variant-b "titles-headings": each
      // neighbor as "Title [section1; section2]" (up to 2 of its level-1 headings) — the richer
      // structural context that may add over titles-only.
      const rendered =
        VARIANT === "titles-headings"
          ? nbrPaths.map((p) => {
              const secs = (sectionsForNote.get(p) ?? []).slice(0, 2);
              return secs.length > 0 ? `${titleOf(p)} [${secs.join("; ")}]` : titleOf(p);
            })
          : nbrPaths.map(titleOf).filter((n, i, arr) => arr.indexOf(n) === i);
      const line = `linked notes: ${rendered.join(", ")}`;
      const nl = base.indexOf("\n\n");
      variantText =
        nl >= 0 ? `${base.slice(0, nl)}\n${line}${base.slice(nl)}` : `${line}\n\n${base}`;
    }
    variantLines.push(JSON.stringify({ chunk_id: c.id, text: variantText }));
  }

  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath as string, "utf8")));
  const queryLines = golden.queries.map((q) => JSON.stringify({ id: q.id, text: q.query_text }));

  writeFileSync(join(outDir as string, "docs_control.jsonl"), `${controlLines.join("\n")}\n`);
  writeFileSync(join(outDir as string, "docs_variant.jsonl"), `${variantLines.join("\n")}\n`);
  writeFileSync(join(outDir as string, "queries.jsonl"), `${queryLines.join("\n")}\n`);
  const changed = controlLines.filter((c, i) => c !== variantLines[i]).length;
  process.stdout.write(
    `wrote ${chunks.length} control + ${chunks.length} variant docs (${changed} differ, variant=${VARIANT}, cap=${CAP}) + ${queryLines.length} queries to ${outDir}\n`,
  );
  db.close?.();
}

void main();
