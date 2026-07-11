// THE-396 feasibility spike — ColBERT late-interaction rescoring of the dense top-K.
//
// Question: does MaxSim rescoring (query ColBERT matrix vs per-chunk matrices) beat the plain
// dense order on the golden set, and at what latency + storage cost? Explicitly NOT an
// integration: no multi-vector search is built into SQLite (one-vector-per-row incompatibility).
//
// Serving reality (THE-395 findings): one vLLM server exposes ONE pooling task, so this spike
// uses two servers — the dense config (embeddings + the indexed pool) and a second bge-m3 server
// launched with `--pooler-config.task token_embed` (COLBERT_URL, default http://127.0.0.1:8002)
// that produces the per-token matrices for the query AND the pool docs on the fly. chunk_colbert
// is empty on such a split-serving setup, so the doc-encode cost measured here is the REAL cost
// late interaction would pay without a store; maxsim-only latency is reported separately as the
// with-store floor.
//
// Usage: COLBERT_URL=http://127.0.0.1:8002 bun eval/colbert_spike.ts <config.json> [golden.yaml]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { type ColbertMatrix, colbertRerank } from "../src/search/colbert";
import { semanticSearch } from "../src/search/semantic";
import {
  aggregateMetrics,
  computeQueryMetrics,
  type GoldenQuery,
  GoldenSetSchema,
  type QueryMetrics,
} from "./metrics";

const POOL = 50;

const norm = (p: string): string => p.replace(/\\/g, "/");
function normQuery(q: GoldenQuery): GoldenQuery {
  return {
    ...q,
    seed_paths: q.seed_paths.map(norm),
    target_paths: q.target_paths.map(norm),
    bridge_paths: q.bridge_paths.map(norm),
  };
}

async function tokenEmbed(base: string, model: string, texts: string[]): Promise<ColbertMatrix[]> {
  const res = await fetch(`${base.replace(/\/$/, "")}/pooling`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts, task: "token_embed" }),
  });
  if (!res.ok) throw new Error(`token_embed HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ data?: number[][] }> };
  return texts.map((_, i) => body.data?.[i]?.data ?? []);
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    process.stderr.write(
      "usage: COLBERT_URL=http://127.0.0.1:8002 bun eval/colbert_spike.ts <config.json> [golden-set.yaml]\n",
    );
    process.exit(2);
  }
  const colbertUrl = process.env.COLBERT_URL ?? "http://127.0.0.1:8002";
  const goldenPath =
    process.argv[3] ?? fileURLToPath(new URL("./multi-hop-golden-set.yaml", import.meta.url));
  const config = loadConfig(configPath);
  const firstVault = config.vaults[0];
  if (!firstVault) throw new Error("config.vaults is empty");
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  const provider = createEmbeddingProvider(config.embeddings);
  const model = config.embeddings.model;
  const db = await openDatabase(join(config.cacheDir, "cache.db"));

  const dense: QueryMetrics[] = [];
  const rescored: QueryMetrics[] = [];
  const encodeMs: number[] = [];
  const maxsimMs: number[] = [];
  for (const raw of golden.queries) {
    const q = normQuery(raw);
    const [qv] = await provider.embed([q.query_text]);
    const pool = semanticSearch(db, firstVault.id, qv ?? [], { k: POOL, returnContent: true });
    const hits = pool.map((h) => ({
      chunk_id: h.chunk_id,
      path: norm(h.path),
      content: h.content ?? "",
    }));
    dense.push(computeQueryMetrics(q, hits));
    const t0 = performance.now();
    const [queryMatrix] = await tokenEmbed(colbertUrl, model, [q.query_text]);
    const docMatrices = await tokenEmbed(
      colbertUrl,
      model,
      hits.map((h) => h.content),
    );
    const t1 = performance.now();
    const docById = new Map<string, ColbertMatrix>();
    hits.forEach((h, i) => {
      const m = docMatrices[i];
      if (m && m.length > 0) docById.set(h.chunk_id, m);
    });
    const reranked = colbertRerank(hits, queryMatrix ?? [], docById);
    const t2 = performance.now();
    encodeMs.push(t1 - t0);
    maxsimMs.push(t2 - t1);
    rescored.push(computeQueryMetrics(q, reranked));
  }

  const d = aggregateMetrics(dense);
  const r = aggregateMetrics(rescored);
  const stat = (xs: number[]): string => {
    const s = [...xs].sort((a, b) => a - b);
    const at = (f: number): number => s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0;
    return `p50 ${at(0.5).toFixed(0)}ms p95 ${at(0.95).toFixed(0)}ms`;
  };
  process.stdout.write(
    `\nTHE-396 ColBERT spike — ${golden.queries.length} queries, pool ${POOL}, model ${model}\n`,
  );
  process.stdout.write(
    `dense:  recall@10 ${d.mean_recall_at_10.toFixed(3)}  nDCG@10 ${d.mean_ndcg_at_10.toFixed(3)}  MRR ${d.mean_mrr_at_10.toFixed(3)}\n`,
  );
  process.stdout.write(
    `maxsim: recall@10 ${r.mean_recall_at_10.toFixed(3)}  nDCG@10 ${r.mean_ndcg_at_10.toFixed(3)}  MRR ${r.mean_mrr_at_10.toFixed(3)}\n`,
  );
  process.stdout.write(
    `latency: doc-encode (no-store cost) ${stat(encodeMs)}; maxsim-only (with-store floor) ${stat(maxsimMs)}\n`,
  );
}

void main();
