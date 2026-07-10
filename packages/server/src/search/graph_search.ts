import type { Database } from "../db/types";
import { bubbleSafeRerank } from "./bubble_safe_rerank";
import { bm25Chunks } from "./chunk_fts";
import { expandGraphLiteral } from "./graph_expand";
import { cosineSimilarity } from "./native";
import { type Reranker, rerankWithScores } from "./rerank";
import { semanticSearch } from "./semantic";
import { blobToFloats } from "./vec";

export type FusionMode = "graph_rrf" | "rrf_rerank" | "score_merge";

// THE-73 Phase 3: default Ebbinghaus decay rate per day for the expansion stream. exp(-0.005*days)
// is a ~139-day half-life — gentle enough that a note stays retrievable for months, steep enough
// that a years-stale hub loses expansion priority. Tunable via opts.decay.lambda.
const DEFAULT_DECAY_LAMBDA = 0.005;
const MS_PER_DAY = 86_400_000;

export interface GraphSearchResult {
  chunk_id: string;
  path: string;
  content?: string;
  source: "seed" | "expansion" | "lexical";
  hop: number;
  via_edge: { type: string; source_path: string; provenance: string | null } | null;
  root_seed: string | null;
  rerank_score: number;
}

export interface GraphSearchOptions {
  query: string;
  queryVec: number[];
  vaultId: string;
  seedCount?: number;
  finalTopK?: number;
  maxExpansionChunks?: number;
  hopLimit?: number;
  similarityThreshold?: number;
  fusionMode?: FusionMode;
  rrfK?: number;
  rerankPool?: number;
  /** THE-73: chunk-level BM25 lexical stream fused into the RRF (third stream). Defaults on;
   *  no-ops when chunk_fts is absent (FTS-less adapter / un-provisioned index). `count` defaults
   *  to seedCount. */
  lexical?: { enabled?: boolean; count?: number };
  /** THE-73 Phase 2: cap how many chunks per cluster_id reach the final result (KMeans
   *  diversification). Off when unset/0; chunks with a NULL cluster_id (unclustered) are never
   *  capped. Populate cluster_id offline via `obsidian-tc cluster`. graph_rrf mode only. */
  maxPerCluster?: number;
  /** THE-73 Phase 3: Ebbinghaus recency weight on the expansion stream — each expansion chunk's
   *  ordering score is multiplied by exp(-lambda * days_since_modified) from notes.mtime, so a stale
   *  hub note loses expansion priority. Off unless enabled; the similarity gate still uses raw
   *  cosine, so decay only reorders/cuts, never drops a chunk below similarityThreshold. lambda
   *  defaults to a ~139-day half-life; nowMs is injectable for deterministic tests. */
  decay?: { enabled?: boolean; lambda?: number; nowMs?: number };
  router?: { enabled?: boolean; simThreshold?: number; margin?: number };
  reranker?: Reranker | null;
  isReadable?: (path: string) => boolean;
  /** cached_activation_score lookup from vault_object_state (W-SCHEMA); inert when absent. */
  activationFor?: (chunkId: string) => number | null | undefined;
}

interface Candidate {
  chunk_id: string;
  path: string;
  content: string;
  source: "seed" | "expansion" | "lexical";
  hop: number;
  via_edge: { type: string; source_path: string; provenance: string | null } | null;
  root_seed: string | null;
  streamRank: number;
}

interface ChunkEmbRow {
  id: string;
  path: string;
  content: string;
  embedding: Uint8Array;
}

/**
 * GraphRAG search — THE-233 W-RETRIEVAL port of knowledge-mcp-server vault_graph_search.
 * Vector seeds (semanticSearch — obsidian-tc has no chunk-level hybrid, and "don't
 * reimplement hybrid" stands) -> seed-strength router -> literal links_to expansion ->
 * RRF fusion. Default graph_rrf (the eval winner: RRF over the seed + expansion streams
 * IS the final ranking, no reranker call, so a rank-1 seed cannot be displaced by an
 * inflated expansion score). rrf_rerank / score_merge route through the injected reranker
 * (D1 gateway passthrough at integration; graceful no-op fallback otherwise).
 */
export async function graphSearch(
  db: Database,
  opts: GraphSearchOptions,
): Promise<GraphSearchResult[]> {
  const seedCount = opts.seedCount ?? 30;
  const finalTopK = opts.finalTopK ?? 30;
  const maxExpansionChunks = opts.maxExpansionChunks ?? 50;
  const hopLimit = opts.hopLimit ?? 2;
  const similarityThreshold = opts.similarityThreshold ?? 0.2;
  const fusionMode = opts.fusionMode ?? "graph_rrf";
  const rrfK = opts.rrfK ?? 60;
  const rerankPool = opts.rerankPool ?? 40;
  const routerEnabled = opts.router?.enabled ?? true;
  const routerSim = opts.router?.simThreshold ?? 0.62;
  const routerMargin = opts.router?.margin ?? 0.08;
  const isReadable = opts.isReadable;
  const decayEnabled = opts.decay?.enabled ?? false;
  const decayLambda = opts.decay?.lambda ?? DEFAULT_DECAY_LAMBDA;
  const decayNowMs = opts.decay?.nowMs ?? Date.now();

  // 1. Vector seeds. semanticSearch returns cosine as `score`, descending.
  const seeds = semanticSearch(db, opts.vaultId, opts.queryVec, {
    k: seedCount,
    returnContent: true,
    ...(isReadable ? { isReadable } : {}),
  });
  // 1b. Lexical seeds (THE-73): chunk-level BM25 stream — empty when chunk_fts is absent or the
  //     query has no usable term. Fetched up front so a pure-lexical query (exact term, no vector
  //     seed) is not dropped by the seeds-empty early return below.
  const lexicalEnabled = opts.lexical?.enabled ?? true;
  const lexHits = lexicalEnabled
    ? bm25Chunks(db, opts.vaultId, opts.query, opts.lexical?.count ?? seedCount)
    : [];
  if (seeds.length === 0 && lexHits.length === 0) return [];

  // 2. Seed-strength router: skip expansion when the baseline is already confident.
  //    semanticSearch score IS cosine, so no recompute (cleaner than the KMS path).
  let routedToSeedsOnly = false;
  if (routerEnabled) {
    const top1 = seeds[0]?.score ?? 0;
    const top4 = seeds[Math.min(3, seeds.length - 1)]?.score ?? top1;
    if (top1 >= routerSim && top1 - top4 >= routerMargin) routedToSeedsOnly = true;
  }

  const seedChunkIds = new Set(seeds.map((s) => s.chunk_id));
  const seedPaths = [...new Set(seeds.map((s) => s.path))];

  // 3. Literal graph expansion (skipped when the router fires). Score each expansion
  //    chunk by cosine to the query and gate at similarityThreshold (KMS semantic_chunks).
  const expansionChunks: Candidate[] = [];
  if (!routedToSeedsOnly) {
    const nodes = expandGraphLiteral(db, seedPaths, { vaultId: opts.vaultId, hopLimit });
    const nodeByPath = new Map(nodes.map((n) => [n.path, n]));
    const paths = [...nodeByPath.keys()];
    if (paths.length > 0) {
      const placeholders = paths.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT c.id AS id, c.path AS path, c.content AS content, e.embedding AS embedding
           FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1
           WHERE c.vault_id = ? AND c.path IN (${placeholders})`,
        )
        .all(opts.vaultId, ...paths) as ChunkEmbRow[];
      const mtimeByPath = decayEnabled
        ? loadMtimes(db, opts.vaultId, paths)
        : new Map<string, number>();
      const scored: Array<{ cand: Candidate; sim: number }> = [];
      for (const r of rows) {
        if (seedChunkIds.has(r.id)) continue;
        if (isReadable && !isReadable(r.path)) continue;
        const node = nodeByPath.get(r.path);
        if (!node) continue;
        const rawSim = cosineSimilarity(opts.queryVec, blobToFloats(r.embedding));
        if (rawSim < similarityThreshold) continue;
        // Ebbinghaus recency weight (THE-73 P3): reorder by recency without dropping below the gate.
        let sim = rawSim;
        if (decayEnabled) {
          const mtime = mtimeByPath.get(r.path);
          if (mtime !== undefined && mtime > 0) {
            const days = Math.max(0, (decayNowMs - mtime) / MS_PER_DAY);
            sim = rawSim * Math.exp(-decayLambda * days);
          }
        }
        scored.push({
          sim,
          cand: {
            chunk_id: r.id,
            path: r.path,
            content: r.content,
            source: "expansion",
            hop: node.hop,
            via_edge: {
              type: node.via_edge_type,
              source_path: node.predecessor_path,
              provenance: node.via_edge_provenance,
            },
            root_seed: node.root_seed,
            streamRank: 0,
          },
        });
      }
      // Expansion stream order: hop asc, similarity desc (KMS vault_graph_expand order).
      scored.sort((a, b) => a.cand.hop - b.cand.hop || b.sim - a.sim);
      let rank = 0;
      for (const s of scored.slice(0, maxExpansionChunks)) {
        s.cand.streamRank = rank++;
        expansionChunks.push(s.cand);
      }
    }
  }

  // 4. Candidate set: seeds (hop 0) + expansion, deduped by chunk_id, seeds win.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let seedRank = 0;
  for (const s of seeds) {
    if (seen.has(s.chunk_id)) continue;
    seen.add(s.chunk_id);
    candidates.push({
      chunk_id: s.chunk_id,
      path: s.path,
      content: s.content ?? "",
      source: "seed",
      hop: 0,
      via_edge: null,
      root_seed: null,
      streamRank: seedRank++,
    });
  }
  for (const c of expansionChunks) {
    if (seen.has(c.chunk_id)) continue;
    seen.add(c.chunk_id);
    candidates.push(c);
  }
  // 4b. Lexical stream (THE-73): rank each visible BM25 hit; add lexical-only chunks as new
  //     candidates, and record ranks so a chunk that ALSO seeds/expands gets an additive RRF bonus
  //     below. ACL-filtered by path; a filtered hit does not consume a rank.
  const lexRankById = new Map<string, number>();
  let lexRank = 0;
  for (const h of lexHits) {
    if (isReadable && !isReadable(h.path)) continue;
    lexRankById.set(h.chunk_id, lexRank);
    if (!seen.has(h.chunk_id)) {
      seen.add(h.chunk_id);
      candidates.push({
        chunk_id: h.chunk_id,
        path: h.path,
        content: h.content ?? "",
        source: "lexical",
        hop: 0,
        via_edge: null,
        root_seed: null,
        streamRank: lexRank,
      });
    }
    lexRank += 1;
  }
  if (candidates.length === 0) return [];

  // 5. Fusion.
  if (fusionMode === "score_merge") {
    const ranked = await rerankWithScores(
      opts.query,
      candidates,
      Math.min(finalTopK, candidates.length),
      opts.reranker,
    );
    return finalize(ranked, opts);
  }

  // RRF fusion (THE-73): each candidate's base contribution is 1/(k + its own stream rank), PLUS an
  // additive lexical contribution when it also appears in the BM25 stream — a chunk matched by two
  // streams outranks a single-stream hit (the point of hybrid). A lexical-only candidate already
  // carries its BM25 rank as streamRank, so its base term IS the lexical term (no double count).
  const rrf = (c: Candidate): number => {
    let s = 1 / (rrfK + c.streamRank);
    if (c.source !== "lexical") {
      const lr = lexRankById.get(c.chunk_id);
      if (lr !== undefined) s += 1 / (rrfK + lr);
    }
    return s;
  };
  const sourceRank: Record<Candidate["source"], number> = { seed: 0, lexical: 1, expansion: 2 };
  const fused = [...candidates].sort((a, b) => {
    const d = rrf(b) - rrf(a);
    if (d !== 0) return d;
    if (a.source !== b.source) return sourceRank[a.source] - sourceRank[b.source];
    return a.streamRank - b.streamRank;
  });

  if (fusionMode === "graph_rrf") {
    const capped =
      opts.maxPerCluster && opts.maxPerCluster > 0
        ? diversifyByCluster(db, opts.vaultId, fused, opts.maxPerCluster, finalTopK)
        : fused.slice(0, finalTopK);
    return capped.map((c) => toResult(c, rrf(c)));
  }

  // rrf_rerank: rerank the top-RRF pool for the final order.
  const pool = fused.slice(0, Math.min(rerankPool, fused.length));
  const ranked = await rerankWithScores(
    opts.query,
    pool,
    Math.min(finalTopK, pool.length),
    opts.reranker,
  );
  return finalize(ranked, opts);
}

// THE-73 Phase 3: note mtimes for the expansion paths (Ebbinghaus decay input). Absent notes table
// (FTS-less / pre-THE-291 index) yields an empty map, so decay silently no-ops (weight stays 1).
function loadMtimes(db: Database, vaultId: string, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (paths.length === 0) return out;
  try {
    const placeholders = paths.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT path, mtime FROM notes WHERE vault_id = ? AND path IN (${placeholders})`)
      .all(vaultId, ...paths) as Array<{ path: string; mtime: number }>;
    for (const r of rows) out.set(r.path, r.mtime);
  } catch {
    // notes table not present on this connection — no decay data.
  }
  return out;
}

// THE-73 Phase 2: walk the RRF-sorted candidates and keep at most maxPerCluster from each cluster_id
// before filling finalTopK, so one dense semantic neighbourhood cannot crowd out the rest. cluster_id
// is looked up in batches; a NULL/absent cluster_id is treated as unique (never capped), so the pass
// is a no-op until `obsidian-tc cluster` has populated the column.
function diversifyByCluster(
  db: Database,
  vaultId: string,
  fused: Candidate[],
  maxPerCluster: number,
  finalTopK: number,
): Candidate[] {
  const clusterOf = new Map<string, number>();
  const ids = fused.map((c) => c.chunk_id);
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, cluster_id FROM chunks WHERE vault_id = ? AND id IN (${placeholders})`)
      .all(vaultId, ...slice) as Array<{ id: string; cluster_id: number | null }>;
    for (const r of rows) if (r.cluster_id != null) clusterOf.set(r.id, r.cluster_id);
  }
  const counts = new Map<number, number>();
  const out: Candidate[] = [];
  for (const c of fused) {
    const cl = clusterOf.get(c.chunk_id);
    if (cl !== undefined) {
      const n = counts.get(cl) ?? 0;
      if (n >= maxPerCluster) continue;
      counts.set(cl, n + 1);
    }
    out.push(c);
    if (out.length >= finalTopK) break;
  }
  return out;
}

function toResult(c: Candidate, score: number): GraphSearchResult {
  return {
    chunk_id: c.chunk_id,
    path: c.path,
    ...(c.content ? { content: c.content } : {}),
    source: c.source,
    hop: c.hop,
    via_edge: c.via_edge,
    root_seed: c.root_seed,
    rerank_score: score,
  };
}

// Apply the optional activation bubble pass (inert without activationFor), then project.
function finalize(
  ranked: Array<{ item: Candidate; score: number }>,
  opts: GraphSearchOptions,
): GraphSearchResult[] {
  if (!opts.activationFor) return ranked.map(({ item, score }) => toResult(item, score));
  const withActivation = ranked.map(({ item, score }) => ({
    item,
    score,
    rerankScore: score,
    activationScore: opts.activationFor?.(item.chunk_id) ?? null,
  }));
  return bubbleSafeRerank(withActivation).map((r) => toResult(r.item, r.score));
}
