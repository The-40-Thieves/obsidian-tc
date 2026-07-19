// THE-441 — export the DEEP top-100 fused candidate pool per golden query, for the one-shot
// Qwen3-Reranker-4B kill-shot. Runs the champion pipeline (same graphSearch the eval's "graph"
// column uses) with finalTopK=100, then joins each candidate to its chunk text so the reranker
// scores query-vs-passage. Output feeds templates/qwen3_rerank.py on the GPU; score-reranked.ts
// closes the loop locally. Keeps GPU-on time to a single batch (ticket: "one-shot, not a serve").
//
// Usage: bun eval/export-rerank-pools.ts <config.json> <golden.yaml> <pools.out.json> [--pool 100]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { graphSearch } from "../src/search/graph_search";
import { GoldenSetSchema } from "./metrics";

const argv = process.argv.slice(2);
const [configPath, goldenPath, outPath] = argv.filter((a) => !a.startsWith("--"));
const poolIdx = argv.indexOf("--pool");
const POOL = poolIdx >= 0 ? Number(argv[poolIdx + 1]) : 100;
if (!configPath || !goldenPath || !outPath) {
  process.stderr.write(
    "usage: bun eval/export-rerank-pools.ts <config.json> <golden.yaml> <pools.out.json> [--pool 100]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const config = loadConfig(configPath as string);
  const vault = config.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const provider = createEmbeddingProvider(config.embeddings);
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath as string, "utf8")));
  // chunk text lookup (raw display content — what a passage reranker should read).
  const textOf = db.prepare("SELECT content FROM chunks WHERE id = ? AND vault_id = ?");

  const queries = [];
  for (const q of golden.queries) {
    const [queryVec] = await provider.embed([q.query_text], { input: "query" });
    const hits = await graphSearch(db, {
      query: q.query_text,
      queryVec: queryVec ?? [],
      vaultId: vault.id,
      finalTopK: POOL,
    });
    const candidates = hits.map((h) => {
      const row = textOf.get(h.chunk_id, vault.id) as { content?: string } | undefined;
      return { chunk_id: h.chunk_id, path: h.path, text: row?.content ?? "" };
    });
    queries.push({ id: q.id, query_text: q.query_text, candidates });
    process.stderr.write(`  ${q.id}: pooled ${candidates.length}\n`);
  }

  writeFileSync(
    outPath as string,
    JSON.stringify(
      {
        instruction: "Given a web search query, retrieve relevant passages that answer the query",
        pool: POOL,
        queries,
      },
      null,
      0,
    ),
  );
  const avg = queries.reduce((a, q) => a + q.candidates.length, 0) / (queries.length || 1);
  process.stdout.write(
    `wrote ${outPath} — ${queries.length} queries, avg pool ${avg.toFixed(1)} (target ${POOL})\n`,
  );
  db.close?.();
}

void main();
