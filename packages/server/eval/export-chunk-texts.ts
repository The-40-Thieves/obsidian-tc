// Export EVERY chunk's embed-text for an off-box (GPU) embedding pass — the companion to
// load-gpu-vecs.ts, which loads the resulting vectors back in.
//
// export-enrichment-texts.ts is the EVAL exporter: a control/variant pair over a golden set,
// defaulting to --cap 12 notes. This is the OPERATIONAL one — the whole vault, one stable order,
// emitting exactly the two files load-gpu-vecs.ts already consumes:
//   ids.json     ["<chunk_id>", ...]           the order the .f32 rows MUST be in
//   texts.jsonl  {"chunk_id":..,"text":..}     one per line, same order
//
// The text is the SHIPPED representation, not a variant of it: enrichChunkText (title + heading
// breadcrumb) when embeddings.chunkContext is on, bare content when it is off. Getting this wrong
// produces vectors that look fine and retrieve badly, since the query side is enriched either way.
//
// Egress-excluded paths are dropped here for the same reason `obsidian-tc index` withholds them
// from embedding: their text must not leave the machine. They are counted, not silent.
//
// Usage: bun eval/export-chunk-texts.ts <config.json> <outdir> [--vault ID]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { compileEgressFilter, isExcludedPath } from "../src/plane/egress-filter";
import { enrichChunkText } from "../src/search/chunk";

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const [configPath, outDir] = pos;
const vIdx = argv.indexOf("--vault");
const ONLY_VAULT = vIdx >= 0 ? argv[vIdx + 1] : undefined;
if (!configPath || !outDir) {
  process.stderr.write(
    "usage: bun eval/export-chunk-texts.ts <config.json> <outdir> [--vault ID]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const cfg = loadConfig(configPath as string);
  const db = await openConfiguredDatabase(cfg, "cache.db");
  const egress = compileEgressFilter(cfg.egress.excludePaths);
  const vaults = ONLY_VAULT ? cfg.vaults.filter((v) => v.id === ONLY_VAULT) : cfg.vaults;
  if (vaults.length === 0) throw new Error(`no such vault: ${ONLY_VAULT ?? "(none configured)"}`);

  const ids: string[] = [];
  const lines: string[] = [];
  let excluded = 0;
  for (const v of vaults) {
    const rows = db
      .prepare(
        "SELECT id, path, headings, content FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
      )
      .all(v.id) as Array<{ id: string; path: string; headings: string; content: string }>;
    for (const r of rows) {
      if (isExcludedPath(egress, r.path)) {
        excluded++;
        continue;
      }
      let headings: string[] = [];
      try {
        headings = JSON.parse(r.headings) as string[];
      } catch {
        headings = []; // a chunk with no headings stores something unparseable; title-only is right
      }
      const text = cfg.embeddings.chunkContext
        ? enrichChunkText(r.path, headings, r.content)
        : r.content;
      ids.push(r.id);
      lines.push(JSON.stringify({ chunk_id: r.id, text }));
    }
  }

  mkdirSync(outDir as string, { recursive: true });
  writeFileSync(join(outDir as string, "ids.json"), JSON.stringify(ids));
  writeFileSync(join(outDir as string, "texts.jsonl"), `${lines.join("\n")}\n`);
  process.stdout.write(
    `exported ${ids.length} chunk(s) -> ${outDir} ` +
      `(chunkContext=${cfg.embeddings.chunkContext}, ${excluded} egress-excluded)\n`,
  );
  db.close?.();
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
