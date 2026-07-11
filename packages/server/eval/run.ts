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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import type { Database } from "../src/db/types";
import { createEmbeddingProvider } from "../src/embeddings";
import { graphSearch, seedZMargin } from "../src/search/graph_search";
import type { Reranker } from "../src/search/rerank";
import { semanticSearch } from "../src/search/semantic";
import type { SparseVec } from "../src/search/sparse";
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
import { describePaired } from "./stats";

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
  /** THE-394: hard query = top-1 dense cosine below the gate threshold (0.55). The acceptance
   *  for the gated reranker is a win on THIS subset. */
  hard: boolean;
  /** THE-400: top-1 z-margin over the dense top-30 pool — the model-agnostic confidence signal;
   *  logged per query so thresholds are picked from a calibration table, never guessed. */
  z1: number;
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
  provider: {
    embed: (texts: string[]) => Promise<number[][]>;
    /** THE-395: multi-representation encode (bge-m3) — enables the sparse query side. */
    embedFull?: (texts: string[]) => Promise<Array<{ dense: number[]; sparse: SparseVec }>>;
  };
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
  /** THE-401: smooth expansion scoring passthrough (continuous hop decay + hub penalty). */
  smoothExpansion?: { enabled?: boolean; lambda?: number; hubMu?: number; hubGamma?: number };
  /** THE-395: encode the query via embedFull and fuse the learned-sparse RRF stream (requires
   *  a bge-m3 provider + an index with chunk_sparse rows). */
  sparse?: boolean;
  /** THE-394: gated cross-encoder rerank passthrough (needs `reranker`). */
  gatedRerank?: { enabled?: boolean; hardTop1?: number; pool?: number };
  /** THE-398: convex-combination fusion (fusionMode "convex") with optional alpha. */
  fusionConvex?: { alpha?: number };
  /** THE-400: route via z-margin at this threshold (replaces the sim/margin router rule). */
  zRouter?: number;
}

/** Run the golden set: per query, compare the semantic baseline vs graph (GraphRAG) top-K. */
export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const perQuery: EvalQueryResult[] = [];
  for (const raw of opts.golden.queries) {
    const q = normQuery(raw);
    let queryVec: number[] = [];
    let querySparse: SparseVec | undefined;
    if (opts.sparse && opts.provider.embedFull) {
      const [full] = await opts.provider.embedFull([q.query_text]);
      queryVec = full?.dense ?? [];
      querySparse = full?.sparse;
    } else {
      const [qv] = await opts.provider.embed([q.query_text]);
      queryVec = qv ?? [];
    }

    const baseRaw = semanticSearch(opts.db, opts.vaultId, queryVec, {
      k: TOP_K,
      ...(opts.isReadable ? { isReadable: opts.isReadable } : {}),
    });
    const hard = (baseRaw[0]?.score ?? 0) < 0.55;
    // THE-400: z over the SAME top-30 dense pool the graph side seeds from (seedCount default 30).
    const z1 = seedZMargin(baseRaw.map((h) => h.score));
    const baseHits = normHits(baseRaw.map((h) => ({ chunk_id: h.chunk_id, path: h.path })));
    const graphRes = await graphSearch(opts.db, {
      query: q.query_text,
      queryVec,
      vaultId: opts.vaultId,
      finalTopK: TOP_K,
      reranker: opts.reranker ?? null,
      ...(opts.seedCount !== undefined ? { seedCount: opts.seedCount } : {}),
      ...(opts.isReadable ? { isReadable: opts.isReadable } : {}),
      ...(opts.router ? { router: opts.router } : {}),
      ...(opts.zRouter !== undefined
        ? { router: { enabled: true, zThreshold: opts.zRouter } }
        : {}),
      ...(opts.adaptiveRrf ? { adaptiveRrf: opts.adaptiveRrf } : {}),
      ...(opts.lexical ? { lexical: opts.lexical } : {}),
      ...(querySparse ? { querySparse } : {}),
      ...(opts.graphStream ? { graphStream: opts.graphStream } : {}),
      ...(opts.smoothExpansion ? { smoothExpansion: opts.smoothExpansion } : {}),
      ...(opts.diversify ? { diversify: opts.diversify } : {}),
      ...(opts.gatedRerank ? { gatedRerank: opts.gatedRerank } : {}),
      ...(opts.fusionConvex ? { fusionMode: "convex" as const, convex: opts.fusionConvex } : {}),
    });
    const graphHits = normHits(graphRes.map((r) => ({ chunk_id: r.chunk_id, path: r.path })));

    perQuery.push({
      id: q.id,
      baseline: computeQueryMetrics(q, baseHits),
      graph: computeQueryMetrics(q, graphHits),
      hard,
      z1,
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
  const smoothExpansion = argv.includes("--smooth-expansion");
  const mmr = argv.includes("--mmr");
  const noLexical = argv.includes("--no-lexical");
  const sparseFlag = argv.includes("--sparse");
  const gatedRerank = argv.includes("--gated-rerank");
  // THE-398: `--fusion convex` switches the fusion; CONVEX_ALPHA overrides the 0.7 default.
  const fusionIdx = argv.indexOf("--fusion");
  const fusionArg = fusionIdx >= 0 ? argv[fusionIdx + 1] : undefined;
  const convexAlpha = process.env.CONVEX_ALPHA ? Number(process.env.CONVEX_ALPHA) : undefined;
  // THE-400: `--z-router <t>` routes on the z-margin; GATED_HARD_Z switches the rerank gate to z.
  const zRouterIdx = argv.indexOf("--z-router");
  const zRouterArg = zRouterIdx >= 0 ? Number(argv[zRouterIdx + 1]) : undefined;
  const hardZ = process.env.GATED_HARD_Z ? Number(process.env.GATED_HARD_Z) : undefined;
  const jsonIdx = argv.indexOf("--json");
  const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined;
  const positional = argv.filter(
    (a, i) =>
      !a.startsWith("--") &&
      (jsonIdx < 0 || i !== jsonIdx + 1) &&
      (fusionIdx < 0 || i !== fusionIdx + 1) &&
      (zRouterIdx < 0 || i !== zRouterIdx + 1),
  );
  const configPath = positional[0];
  if (!configPath) {
    process.stderr.write(
      "usage: bun eval/run.ts <config.json> [golden-set.yaml] [--adaptive-rrf] [--graph-stream] [--mmr]\n" +
        "Compares vault_graph_search vs the semantic baseline over the golden set (recall@10).\n" +
        "--adaptive-rrf enables THE-391 per-query IDF-weighted fusion for the graph side.\n" +
        "--graph-stream enables the THE-393 capped expansion stream (top seeds, per-seed cap, hub suppression).\n" +
        "--smooth-expansion enables THE-401 continuous expansion scoring (cos·λ^(hop−1)·hub-penalty; replaces hop-sort + hard cap).\n" +
        "--fusion convex enables THE-398 score-normalized convex-combination fusion (CONVEX_ALPHA env, default 0.7).\n" +
        "--z-router <t> enables THE-400 z-margin routing (skip expansion when top-1 z >= t; replaces sim/margin rule).\n" +
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
  // THE-394: a Cohere/Jina-shaped /rerank backend for the eval (TEI or vLLM), injected via
  // RERANK_URL. Production routes through the gateway seam; this keeps the A/B self-contained.
  const rerankUrl = process.env.RERANK_URL;
  const reranker: Reranker | null = rerankUrl
    ? async (query, documents, topN) => {
        const res = await fetch(`${rerankUrl.replace(/\/$/, "")}/rerank`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, documents, texts: documents, top_n: topN }),
        });
        if (!res.ok) throw new Error(`rerank HTTP ${res.status}`);
        const body = (await res.json()) as
          | { results?: Array<{ index: number; relevance_score?: number; score?: number }> }
          | Array<{ index: number; score?: number; relevance_score?: number }>;
        const rows = Array.isArray(body) ? body : (body.results ?? []);
        return rows.map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score ?? r.score ?? 0,
        }));
      }
    : null;
  const report = await runEval({
    db,
    provider,
    golden,
    vaultId: firstVault.id,
    ...(adaptive ? { adaptiveRrf: { enabled: true } } : {}),
    ...(graphStream ? { graphStream: { enabled: true } } : {}),
    ...(smoothExpansion ? { smoothExpansion: { enabled: true } } : {}),
    ...(mmr ? { diversify: { maxPerNote: 2, mmr: { enabled: true } } } : {}),
    ...(noLexical ? { lexical: { enabled: false } } : {}),
    ...(sparseFlag ? { sparse: true } : {}),
    ...(gatedRerank
      ? { gatedRerank: { enabled: true, ...(hardZ !== undefined ? { hardZ } : {}) } }
      : {}),
    ...(zRouterArg !== undefined && !Number.isNaN(zRouterArg) ? { zRouter: zRouterArg } : {}),
    ...(fusionArg === "convex"
      ? { fusionConvex: { ...(convexAlpha !== undefined ? { alpha: convexAlpha } : {}) } }
      : {}),
    ...(reranker ? { reranker } : {}),
  });

  const e = config.embeddings;
  const flags = [
    adaptive ? "adaptive RRF" : null,
    graphStream ? "capped graph stream" : null,
    smoothExpansion ? "smooth expansion" : null,
    mmr ? "note-collapse+MMR" : null,
    noLexical ? "lexical OFF" : null,
    sparseFlag ? "sparse stream" : null,
    gatedRerank ? `gated rerank${hardZ !== undefined ? ` z<${hardZ}` : ""}` : null,
    fusionArg === "convex" ? `convex fusion a=${convexAlpha ?? 0.7}` : null,
    zRouterArg !== undefined ? `z-router@${zRouterArg}` : null,
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
  // THE-394 acceptance slice: the gated reranker must win on the HARD subset.
  const hardQ = report.perQuery.filter((r) => r.hard);
  if (hardQ.length > 0) {
    const hb = aggregateMetrics(hardQ.map((r) => r.baseline));
    const hg = aggregateMetrics(hardQ.map((r) => r.graph));
    process.stdout.write(
      `hard subset (${hardQ.length}/${report.perQuery.length}): recall ${hb.mean_recall_at_10.toFixed(3)} -> ${hg.mean_recall_at_10.toFixed(3)}; nDCG ${hb.mean_ndcg_at_10.toFixed(3)} -> ${hg.mean_ndcg_at_10.toFixed(3)}; MRR ${hb.mean_mrr_at_10.toFixed(3)} -> ${hg.mean_mrr_at_10.toFixed(3)}\n`,
    );
  }
  // THE-400 calibration: the z1 distribution over the golden set (per-backbone), so routing /
  // hardness thresholds are read off real quantiles instead of guessed.
  const zs = report.perQuery.map((r) => r.z1).sort((a, b) => a - b);
  const zq = (p: number): number => zs[Math.min(zs.length - 1, Math.floor(p * zs.length))] ?? 0;
  process.stdout.write(
    `\nz-margin calibration: min ${(zs[0] ?? 0).toFixed(2)}  p25 ${zq(0.25).toFixed(2)}  median ${zq(0.5).toFixed(2)}  p75 ${zq(0.75).toFixed(2)}  max ${(zs[zs.length - 1] ?? 0).toFixed(2)}\n`,
  );
  process.stdout.write(
    `\nship gate (graph >= baseline +20pp multi-hop recall): ${report.recallDeltaPp >= 20 ? "PASS" : "below target"}; no-regression: ${report.noRegression ? "PASS" : "FAIL"}\n`,
  );
  // THE-399: paired statistics — graph vs baseline on the SAME queries. Raw p-values; the
  // BH-FDR multiple-comparison policy + ship rule live in eval/README.md.
  const dN = report.perQuery.map((r) => r.graph.ndcg_at_10 - r.baseline.ndcg_at_10);
  const dR = report.perQuery.map((r) => r.graph.recall_at_10 - r.baseline.recall_at_10);
  process.stdout.write(`\n${describePaired(dN, "graph-vs-baseline ΔnDCG@10 ")}\n`);
  process.stdout.write(`${describePaired(dR, "graph-vs-baseline Δrecall@10")}\n`);
  if (jsonPath) {
    const flags = [
      adaptive && "adaptive-rrf",
      graphStream && "graph-stream",
      smoothExpansion && "smooth-expansion",
      mmr && "mmr",
      noLexical && "no-lexical",
      sparseFlag && "sparse",
      gatedRerank && "gated-rerank",
      fusionArg === "convex" && `convex@${convexAlpha ?? 0.7}`,
      zRouterArg !== undefined && `z-router@${zRouterArg}`,
    ].filter((x): x is string => typeof x === "string");
    writeFileSync(jsonPath, JSON.stringify({ flags, perQuery: report.perQuery }, null, 2));
    process.stdout.write(`wrote ${jsonPath}\n`);
  }
  process.exit(report.noRegression ? 0 : 1);
}

// Only run the CLI when invoked directly (bun sets import.meta.main); importing for tests does not.
if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
