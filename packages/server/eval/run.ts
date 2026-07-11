// THE-233 retrieval eval harness (Batch 4b). Runs vault_graph_search against the semantic
// baseline over the multi-hop golden set and reports recall@10 / bridge-recall, with the ship
// gate (graph beats baseline by >=20pp multi-hop recall; no regression). `runEval` is the
// testable core (db + embedding provider injected); `main` is the CLI.
//
// Requires an INDEXED cache.db (run the server's boot reconcile / index_vault first so chunks,
// embeddings, and vault_edges are populated) and a reachable embedding backend (config-driven).
// The deterministic mechanism is already gated by test/graph-recall.test.ts + test/eval-run.test.ts;
// this CLI produces the REAL numbers once an embedding backend (e.g. BGE-M3 via Ollama @ 1024d)
// and a real index exist. No secrets in the tree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { createEmbeddingProvider } from "../src/embeddings";
import { graphSearch } from "../src/search/graph_search";
import type { Reranker } from "../src/search/rerank";
import { semanticSearch } from "../src/search/semantic";
import {
  type AggregateMetrics,
  aggregateMetrics,
  computeQueryMetrics,
  type GoldenQuery,
  type GoldenSet,
  GoldenSetSchema,
  type QueryMetrics,
  type RankedChunk,
} from "./metrics";

const TOP_K = 30;

// Golden-set paths are Windows-style (KMS-era); normalize both sides to forward slashes so the
// comparison is separator-agnostic against whatever the local index stored.
const norm = (p: string): string => p.replace(/\\/g, "/");
function normQuery(q: GoldenQuery): GoldenQuery {
  return {
    ...q,
    seed_paths: q.seed_paths.map(norm),
    target_paths: q.target_paths.map(norm),
    bridge_paths: q.bridge_paths.map(norm),
  };
}
function normHits(hits: RankedChunk[]): RankedChunk[] {
  return hits.map((h) => ({ ...h, path: norm(h.path) }));
}

export interface EvalQueryResult {
  id: string;
  baseline: QueryMetrics;
  graph: QueryMetrics;
}

export interface EvalReport {
  perQuery: EvalQueryResult[];
  baselineAgg: AggregateMetrics;
  graphAgg: AggregateMetrics;
  recallDeltaPp: number;
  bridgeDeltaPp: number;
  noRegression: boolean;
}

export interface RunEvalOptions {
  db: Database;
  provider: { embed: (texts: string[]) => Promise<number[][]> };
  golden: GoldenSet;
  vaultId: string;
  reranker?: Reranker | null;
  isReadable?: (rel: string) => boolean;
  /** Seed count (graphSearch default 30); eval sweeps may lower it. */
  seedCount?: number;
  /** Seed-strength router config passthrough (eval sweeps tune/disable it). */
  router?: { enabled?: boolean; simThreshold?: number; margin?: number };
  /** THE-391: adaptive RRF passthrough — the A/B lever for the golden-set gate. */
  adaptiveRrf?: { enabled?: boolean; gain?: number };
  /** THE-73 lexical stream passthrough (eval sweeps disable it for a dense+graph reference). */
  lexical?: { enabled?: boolean; count?: number };
  /** THE-393: capped graph stream + diversification passthroughs (same A/B purpose). */
  graphStream?: {
    enabled?: boolean;
    expansionSeeds?: number;
    perSeedCap?: number;
    hubDegreeCap?: number;
  };
  diversify?: { maxPerNote?: number; mmr?: { enabled?: boolean; lambda?: number } };
}

/** Run the golden set: per query, compare the semantic baseline vs graph (GraphRAG) top-K. */
export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const perQuery: EvalQueryResult[] = [];
  for (const raw of opts.golden.queries) {
    const q = normQuery(raw);
    const [qv] = await opts.provider.embed([q.query_text]);
    const queryVec = qv ?? [];

    const baseHits = normHits(
      semanticSearch(opts.db, opts.vaultId, queryVec, {
        k: TOP_K,
        ...(opts.isReadable ? { isReadable: opts.isReadable } : {}),
      }).map((h) => ({ chunk_id: h.chunk_id, path: h.path })),
    );
    const graphRes = await graphSearch(opts.db, {
      query: q.query_text,
      queryVec,
      vaultId: opts.vaultId,
      finalTopK: TOP_K,
      reranker: opts.reranker ?? null,
      ...(opts.seedCount !== undefined ? { seedCount: opts.seedCount } : {}),
      ...(opts.isReadable ? { isReadable: opts.isReadable } : {}),
      ...(opts.router ? { router: opts.router } : {}),
      ...(opts.adaptiveRrf ? { adaptiveRrf: opts.adaptiveRrf } : {}),
      ...(opts.lexical ? { lexical: opts.lexical } : {}),
      ...(opts.graphStream ? { graphStream: opts.graphStream } : {}),
      ...(opts.diversify ? { diversify: opts.diversify } : {}),
    });
    const graphHits = normHits(graphRes.map((r) => ({ chunk_id: r.chunk_id, path: r.path })));

    perQuery.push({
      id: q.id,
      baseline: computeQueryMetrics(q, baseHits),
      graph: computeQueryMetrics(q, graphHits),
    });
  }

  const baselineAgg = aggregateMetrics(perQuery.map((p) => p.baseline));
  const graphAgg = aggregateMetrics(perQuery.map((p) => p.graph));
  const recallDeltaPp = (graphAgg.mean_recall_at_10 - baselineAgg.mean_recall_at_10) * 100;
  const bridgeDeltaPp = (graphAgg.bridge_recall_rate - baselineAgg.bridge_recall_rate) * 100;
  return {
    perQuery,
    baselineAgg,
    graphAgg,
    recallDeltaPp,
    bridgeDeltaPp,
    noRegression: recallDeltaPp >= 0,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const adaptive = argv.includes("--adaptive-rrf");
  const graphStream = argv.includes("--graph-stream");
  const mmr = argv.includes("--mmr");
  const noLexical = argv.includes("--no-lexical");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const configPath = positional[0];
  if (!configPath) {
    process.stderr.write(
      "usage: bun eval/run.ts <config.json> [golden-set.yaml] [--adaptive-rrf] [--graph-stream] [--mmr]\n" +
        "Compares vault_graph_search vs the semantic baseline over the golden set (recall@10).\n" +
        "--adaptive-rrf enables THE-391 per-query IDF-weighted fusion for the graph side.\n" +
        "--graph-stream enables the THE-393 capped expansion stream (top seeds, per-seed cap, hub suppression).\n" +
        "--mmr enables THE-393 diversification (note-collapse maxPerNote=2 + MMR final pick).\n" +
        "Needs an indexed cache.db + a reachable embedding backend (config.embeddings).\n",
    );
    process.exit(2);
  }
  const goldenPath =
    positional[1] ?? fileURLToPath(new URL("./multi-hop-golden-set.yaml", import.meta.url));
  const config = loadConfig(configPath);
  const firstVault = config.vaults[0];
  if (!firstVault) throw new Error("config.vaults is empty");

  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  const provider = createEmbeddingProvider(config.embeddings);
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  const report = await runEval({
    db,
    provider,
    golden,
    vaultId: firstVault.id,
    ...(adaptive ? { adaptiveRrf: { enabled: true } } : {}),
    ...(graphStream ? { graphStream: { enabled: true } } : {}),
    ...(mmr ? { diversify: { maxPerNote: 2, mmr: { enabled: true } } } : {}),
    ...(noLexical ? { lexical: { enabled: false } } : {}),
  });

  const e = config.embeddings;
  const flags = [
    adaptive ? "adaptive RRF" : null,
    graphStream ? "capped graph stream" : null,
    mmr ? "note-collapse+MMR" : null,
    noLexical ? "lexical OFF" : null,
  ]
    .filter((f) => f !== null)
    .join(", ");
  process.stdout.write(
    `\nTHE-233 retrieval eval — ${report.perQuery.length} queries (embeddings ${e.provider}:${e.model} @ ${e.dimensions}d${flags ? `, ${flags}` : ""})\n\n`,
  );
  process.stdout.write(`${"query".padEnd(44)}baseline  graph\n`);
  for (const r of report.perQuery) {
    process.stdout.write(
      `${r.id.padEnd(44)}${r.baseline.recall_at_10.toFixed(2)}      ${r.graph.recall_at_10.toFixed(2)}\n`,
    );
  }
  const pp = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(1)}pp`;
  process.stdout.write(
    `\nmean recall@10: ${report.baselineAgg.mean_recall_at_10.toFixed(3)} -> ${report.graphAgg.mean_recall_at_10.toFixed(3)} (${pp(report.recallDeltaPp)})\n`,
  );
  process.stdout.write(
    `mean nDCG@10:   ${report.baselineAgg.mean_ndcg_at_10.toFixed(3)} -> ${report.graphAgg.mean_ndcg_at_10.toFixed(3)}\n`,
  );
  process.stdout.write(
    `mean MRR@10:    ${report.baselineAgg.mean_mrr_at_10.toFixed(3)} -> ${report.graphAgg.mean_mrr_at_10.toFixed(3)}\n`,
  );
  process.stdout.write(
    `bridge recall:  ${report.baselineAgg.bridge_recall_rate.toFixed(3)} -> ${report.graphAgg.bridge_recall_rate.toFixed(3)} (${pp(report.bridgeDeltaPp)})\n`,
  );
  process.stdout.write(
    `\nship gate (graph >= baseline +20pp multi-hop recall): ${report.recallDeltaPp >= 20 ? "PASS" : "below target"}; no-regression: ${report.noRegression ? "PASS" : "FAIL"}\n`,
  );
  process.exit(report.noRegression ? 0 : 1);
}

// Only run the CLI when invoked directly (bun sets import.meta.main); importing for tests does not.
if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
