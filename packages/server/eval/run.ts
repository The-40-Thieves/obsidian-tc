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
import { pairSparse } from "../src/embeddings/bge-m3";
import { graphSearch, seedZMargin } from "../src/search/graph_search";
import type { Reranker } from "../src/search/rerank";
import { lexicalRouteResults, routeQuery } from "../src/search/router";
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
    /** THE-405: query embeds pass input:"query" so an asymmetric-prefix provider conditions them. */
    embed: (texts: string[], opts?: { input?: "query" | "document" }) => Promise<number[][]>;
    /** THE-395: multi-representation encode (bge-m3) — enables the sparse query side. */
    embedFull?: (
      texts: string[],
      opts?: { input?: "query" | "document" },
    ) => Promise<Array<{ dense: number[]; sparse: SparseVec }>>;
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
  /** THE-221: conditional temporal stream (fires only on queries with explicit temporal intent). */
  temporal?: boolean;
  /** THE-187: cached_activation_score lookup (experiential store) threaded into graphSearch's
   *  bubble pass — the eval exercises the SAME mechanism the serve path gates behind
   *  experiential.activationRerank, killing the eval/serve skew. */
  activation?: (chunkId: string) => number | null;
  /** THE-258: the deterministic class router — same rules as the serve path
   *  (retrieval.classRouter): lexical short-circuit + temporal auto-stream. */
  classRouter?: boolean;
  /** THE-404 spike: for z-HARD queries only (z1 < zThreshold, default 2.54), decompose the query
   *  into 2–3 atomic sub-queries via a small local instruct LLM (Ollama /api/chat), run the full
   *  graph search per sub-query (original included), and RRF-merge the ranked lists. Easy queries
   *  are untouched — the research consensus is that BLANKET augmentation harms private corpora. */
  decompose?: { zThreshold?: number; model?: string; baseUrl?: string };
}

/** THE-404: 2–3 atomic sub-queries from a small local instruct model (temperature 0). Returns []
 *  on any failure — the caller then falls back to the plain single-query path, so a missing or
 *  broken LLM degrades the spike to the baseline, never breaks the eval. */
async function decomposeQuery(query: string, model: string, baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              "Decompose the user's question into 2-3 self-contained atomic search queries for a personal knowledge base. Each sub-query targets ONE entity or concept from the question, phrased in the question's own vocabulary. Output ONLY the sub-queries, one per line, no numbering, no commentary.",
          },
          { role: "user", content: query },
        ],
      }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { message?: { content?: string } };
    return (body.message?.content ?? "")
      .split("\n")
      .map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim())
      .filter((l) => l.length > 3)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** THE-404: RRF-merge ranked chunk lists (position-based, k=10), dedup by chunk_id. */
function rrfMergeLists(lists: RankedChunk[][], topK: number): RankedChunk[] {
  const score = new Map<string, { s: number; item: RankedChunk }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const cur = score.get(item.chunk_id);
      const s = (cur?.s ?? 0) + 1 / (10 + rank);
      score.set(item.chunk_id, { s, item: cur?.item ?? item });
    });
  }
  return [...score.values()]
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
    .map((e) => e.item);
}

/** Run the golden set: per query, compare the semantic baseline vs graph (GraphRAG) top-K. */
export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const perQuery: EvalQueryResult[] = [];
  for (const raw of opts.golden.queries) {
    const q = normQuery(raw);
    let queryVec: number[] = [];
    let querySparse: SparseVec | undefined;
    if (opts.sparse && opts.provider.embedFull) {
      const [full] = await opts.provider.embedFull([q.query_text], { input: "query" });
      queryVec = full?.dense ?? [];
      querySparse = full?.sparse;
    } else {
      const [qv] = await opts.provider.embed([q.query_text], { input: "query" });
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
    const runGraph = async (
      text: string,
      vec: number[],
      sparse?: SparseVec,
      temporalOverride?: boolean,
    ): Promise<RankedChunk[]> => {
      const res = await graphSearch(opts.db, {
        query: text,
        queryVec: vec,
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
        ...(sparse ? { querySparse: sparse } : {}),
        ...(opts.graphStream ? { graphStream: opts.graphStream } : {}),
        ...(opts.smoothExpansion ? { smoothExpansion: opts.smoothExpansion } : {}),
        ...(opts.diversify ? { diversify: opts.diversify } : {}),
        ...(opts.gatedRerank ? { gatedRerank: opts.gatedRerank } : {}),
        ...(opts.fusionConvex ? { fusionMode: "convex" as const, convex: opts.fusionConvex } : {}),
        ...(opts.temporal || temporalOverride ? { temporal: { enabled: true } } : {}),
        ...(opts.activation ? { activationFor: opts.activation } : {}),
      });
      return normHits(res.map((r) => ({ chunk_id: r.chunk_id, path: r.path })));
    };
    // THE-258: the class router, same rules as serve. Lexical short-circuits to enriched
    // BM25 (no embed on serve; the eval already has the vec but ranks identically);
    // temporal auto-enables the stream; standard is byte-identical to the static engine.
    const route = opts.classRouter
      ? routeQuery(opts.db, opts.vaultId, q.query_text)
      : { class: "standard" as const, signals: [] as string[] };
    let graphHits =
      route.class === "lexical"
        ? normHits(
            lexicalRouteResults(opts.db, opts.vaultId, q.query_text, TOP_K, opts.isReadable).map(
              (r) => ({ chunk_id: r.chunk_id, path: r.path }),
            ),
          )
        : await runGraph(q.query_text, queryVec, querySparse, route.class === "temporal");
    // THE-404 spike: z-HARD queries only — decompose into atomic sub-queries, run the full
    // pipeline per sub-query (each lands its own seeds + expansion), RRF-merge the ranked lists
    // (original included). Empty decomposition (LLM missing/broken) falls back to the plain path.
    if (opts.decompose && z1 < (opts.decompose.zThreshold ?? 2.54)) {
      const subs = await decomposeQuery(
        q.query_text,
        opts.decompose.model ?? "llama3.2:3b",
        opts.decompose.baseUrl ?? "http://127.0.0.1:11434",
      );
      if (subs.length > 0) {
        const vecs = await opts.provider.embed(subs, { input: "query" });
        const lists = [graphHits];
        for (let i = 0; i < subs.length; i++) {
          const sv = vecs[i];
          const st = subs[i];
          if (sv && st) lists.push(await runGraph(st, sv));
        }
        graphHits = rrfMergeLists(lists, TOP_K);
      }
    }

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
  // THE-221: `--temporal` — conditional temporal stream.
  const temporal = argv.includes("--temporal");
  // THE-187: `--activation` — thread the experiential store's cached activation scores into
  // the graph bubble pass (the serve mechanism, measured).
  const activation = argv.includes("--activation");
  // THE-258: `--class-router` — the deterministic class router (lexical short-circuit +
  // temporal auto-stream), same rules as retrieval.classRouter on serve.
  const classRouter = argv.includes("--class-router");
  // THE-404: `--decompose` — LLM sub-query decomposition for z-hard queries only
  // (DECOMPOSE_MODEL / DECOMPOSE_Z / DECOMPOSE_URL envs).
  const decompose = argv.includes("--decompose");
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
        "--decompose enables THE-404 sub-query decomposition for z-hard queries (Ollama; DECOMPOSE_MODEL/DECOMPOSE_Z envs).\n" +
        "--temporal enables the THE-221 conditional temporal stream (fires only on explicit temporal intent).\n" +
        "SPARSE_URL=<bge-m3 token_classify server> + --sparse fuses the learned-sparse stream into a NON-bge dense pipeline (THE-403).\n" +
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
  const baseProvider = createEmbeddingProvider(config.embeddings);
  // THE-403: SPARSE_URL composes a MIXED provider — dense query vectors from the config provider
  // (must match the index's embeddings, e.g. nomic), learned-sparse query weights from a bge-m3
  // token_classify vLLM server. This is the "sparse stream alongside the nomic pipeline" gate;
  // chunk_sparse must already be backfilled into the cache (same enriched text).
  const sparseUrl = process.env.SPARSE_URL;
  const provider = sparseUrl
    ? {
        embed: (texts: string[], o?: { input?: "query" | "document" }) =>
          baseProvider.embed(texts, o),
        // THE-403 usage is query-side only, so the dense half carries the query intent.
        embedFull: async (texts: string[]) => {
          const dense = await baseProvider.embed(texts, { input: "query" });
          const root = sparseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
          const model = "BAAI/bge-m3";
          const post = async (url: string, body: unknown): Promise<unknown> => {
            const r = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
            return r.json();
          };
          const pool = (await post(`${root}/pooling`, {
            model,
            input: texts,
            task: "token_classify",
          })) as { data?: Array<{ data?: number[] }> };
          const out: Array<{ dense: number[]; sparse: SparseVec }> = [];
          for (let i = 0; i < texts.length; i++) {
            const tok = (await post(`${root}/tokenize`, { model, prompt: texts[i] })) as {
              tokens?: number[];
            };
            out.push({
              dense: dense[i] ?? [],
              sparse: pairSparse(tok.tokens ?? [], pool.data?.[i]?.data ?? []),
            });
          }
          return out;
        },
      }
    : baseProvider;
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  // THE-187: --activation loads the experiential store's cached scores once (read-only) into
  // a map; a missing store/table degrades to an empty map (all-inert) with a stderr note.
  let activationLookup: ((chunkId: string) => number | null) | undefined;
  if (activation) {
    const map = new Map<string, number>();
    try {
      const edb = await openDatabase(join(config.cacheDir, "experiential.db"));
      try {
        const rows = edb
          .prepare(
            "SELECT object_id, cached_activation_score AS s FROM vault_object_state WHERE cached_activation_score IS NOT NULL",
          )
          .all() as Array<{ object_id: string; s: number }>;
        for (const r of rows) map.set(r.object_id, r.s);
      } finally {
        edb.close?.();
      }
    } catch (err) {
      process.stderr.write(
        `--activation: experiential store unavailable (${err instanceof Error ? err.message : String(err)}); running all-inert\n`,
      );
    }
    process.stderr.write(`--activation: ${map.size} chunk(s) carry activation state\n`);
    activationLookup = (chunkId) => map.get(chunkId) ?? null;
  }
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
    ...(temporal ? { temporal: true } : {}),
    ...(activationLookup ? { activation: activationLookup } : {}),
    ...(classRouter ? { classRouter: true } : {}),
    ...(decompose
      ? {
          decompose: {
            ...(process.env.DECOMPOSE_MODEL ? { model: process.env.DECOMPOSE_MODEL } : {}),
            ...(process.env.DECOMPOSE_Z ? { zThreshold: Number(process.env.DECOMPOSE_Z) } : {}),
            ...(process.env.DECOMPOSE_URL ? { baseUrl: process.env.DECOMPOSE_URL } : {}),
          },
        }
      : {}),
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
    decompose ? `decompose(z<${process.env.DECOMPOSE_Z ?? 2.54})` : null,
    temporal ? "temporal stream" : null,
    activation ? "activation bubble" : null,
    classRouter ? "class router" : null,
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
      decompose && `decompose@${process.env.DECOMPOSE_Z ?? 2.54}`,
      temporal && "temporal",
      activation && "activation",
      classRouter && "class-router",
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
