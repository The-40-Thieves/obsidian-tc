import type { Database } from "../db/types";
import { bubbleSafeRerank } from "./bubble_safe_rerank";
import { expandGraphLiteral } from "./graph_expand";
import { cosineSimilarity } from "./native";
import { type Reranker, rerankWithScores } from "./rerank";
import { semanticSearch } from "./semantic";
import { blobToFloats } from "./vec";

export type FusionMode = "graph_rrf" | "rrf_rerank" | "score_merge";

export interface GraphSearchResult {
  chunk_id: string;
  path: string;
  content?: string;
  source: "seed" | "expansion";
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
  source: "seed" | "expansion";
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

  // 1. Vector seeds. semanticSearch returns cosine as `score`, descending.
  const seeds = semanticSearch(db, opts.vaultId, opts.queryVec, {
    k: seedCount,
    returnContent: true,
    ...(isReadable ? { isReadable } : {}),
  });
  if (seeds.length === 0) return [];

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
      const scored: Array<{ cand: Candidate; sim: number }> = [];
      for (const r of rows) {
        if (seedChunkIds.has(r.id)) continue;
        if (isReadable && !isReadable(r.path)) continue;
        const node = nodeByPath.get(r.path);
        if (!node) continue;
        const sim = cosineSimilarity(opts.queryVec, blobToFloats(r.embedding));
        if (sim < similarityThreshold) continue;
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

  // RRF over the two streams: each candidate is in exactly one stream after dedup.
  const rrf = (c: Candidate): number => 1 / (rrfK + c.streamRank);
  const fused = [...candidates].sort((a, b) => {
    const d = rrf(b) - rrf(a);
    if (d !== 0) return d;
    if (a.source !== b.source) return a.source === "seed" ? -1 : 1;
    return a.streamRank - b.streamRank;
  });

  if (fusionMode === "graph_rrf") {
    return fused.slice(0, finalTopK).map((c) => toResult(c, rrf(c)));
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
