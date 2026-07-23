// THE-465 "candidateAssembly" stage: merges the seed/expansion/lexical/sparse/temporal streams
// into one deduped Candidate[] (seeds win ties), recording each stream's per-chunk rank/score so
// the fusion stage can compute the additive cross-stream RRF bonus. Moved verbatim out of
// graphSearchCore's steps 4/4b/4c/4d — same ACL filtering (isReadable checks inline per stream,
// unreadable hits never consume a rank), same dedup-by-chunk_id-seeds-win order.
import type { Database } from "../../db/types";
import type { LexicalHit } from "../chunk_fts";
import type { SemanticHit } from "../semantic";
import type { SparseHit } from "../sparse";
import { noteDateMs, parseTemporalIntent } from "../temporal";
import type { Candidate, GraphSearchOptions } from "./types";

export interface CandidateAssemblyInput {
  db: Database;
  opts: GraphSearchOptions;
  seedCount: number;
  seeds: SemanticHit[];
  expansionChunks: Candidate[];
  lexHits: LexicalHit[];
  sparseHits: SparseHit[];
  /** THE-459 count-only callback — fired at exactly the same three points ("seed", "expand",
   *  "lexical") as before the THE-465 extraction, with the same cumulative candidate counts. */
  onStage: ((stage: string, count: number) => void) | undefined;
}

export interface CandidateAssemblyResult {
  candidates: Candidate[];
  lexRankById: Map<string, number>;
  // THE-398: bm25() is negative-better; negated so the convex normalizer sees higher-is-better.
  lexScoreById: Map<string, number>;
  sparseRankById: Map<string, number>;
  sparseScoreById: Map<string, number>;
  temporalRankById: Map<string, number>;
}

export function assembleCandidates(input: CandidateAssemblyInput): CandidateAssemblyResult {
  const { db, opts, seedCount, seeds, expansionChunks, lexHits, sparseHits, onStage } = input;
  const isReadable = opts.isReadable;

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
  onStage?.("seed", candidates.length);
  for (const c of expansionChunks) {
    if (seen.has(c.chunk_id)) continue;
    seen.add(c.chunk_id);
    candidates.push(c);
  }
  onStage?.("expand", candidates.length);
  // 4b. Lexical stream (THE-73): rank each visible BM25 hit; add lexical-only chunks as new
  //     candidates, and record ranks so a chunk that ALSO seeds/expands gets an additive RRF bonus
  //     below. ACL-filtered by path; a filtered hit does not consume a rank.
  const lexRankById = new Map<string, number>();
  const lexScoreById = new Map<string, number>();
  let lexRank = 0;
  for (const h of lexHits) {
    if (isReadable && !isReadable(h.path)) continue;
    lexRankById.set(h.chunk_id, lexRank);
    lexScoreById.set(h.chunk_id, -h.rank);
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
  onStage?.("lexical", candidates.length);
  // 4c. Learned-sparse stream (THE-388): same shape as the lexical stream, over bge-m3 sparse
  //     weights. Sparse-only chunks enter as candidates; a chunk also in another stream gets an
  //     additive RRF bonus below.
  const sparseRankById = new Map<string, number>();
  const sparseScoreById = new Map<string, number>();
  let sparseRank = 0;
  for (const h of sparseHits) {
    if (isReadable && !isReadable(h.path)) continue;
    sparseRankById.set(h.chunk_id, sparseRank);
    sparseScoreById.set(h.chunk_id, h.score);
    if (!seen.has(h.chunk_id)) {
      seen.add(h.chunk_id);
      candidates.push({
        chunk_id: h.chunk_id,
        path: h.path,
        content: h.content ?? "",
        source: "sparse",
        hop: 0,
        via_edge: null,
        root_seed: null,
        streamRank: sparseRank,
      });
    }
    sparseRank += 1;
  }
  // 4d. Temporal stream (THE-221): conditional on explicit temporal intent in the query; empty
  //     otherwise, so non-temporal queries fuse exactly as before. Notes are matched by filename
  //     date inside the parsed range and ranked by proximity to the range midpoint; a chunk also
  //     found by another stream gets the additive RRF bonus below, like lexical/sparse.
  const temporalRankById = new Map<string, number>();
  if (opts.temporal?.enabled ?? false) {
    const range = parseTemporalIntent(opts.query, opts.temporal?.nowMs ?? Date.now());
    if (range) {
      const mid = (range.start + range.end) / 2;
      const dated = (
        db
          .prepare("SELECT DISTINCT path FROM chunks WHERE vault_id = ?")
          .all(opts.vaultId) as Array<{
          path: string;
        }>
      )
        .map((r) => ({ path: r.path, date: noteDateMs(r.path) }))
        .filter(
          (p): p is { path: string; date: number } =>
            p.date !== null && p.date >= range.start && p.date <= range.end,
        )
        .sort((a, b) => Math.abs(a.date - mid) - Math.abs(b.date - mid) || b.date - a.date);
      const cap = opts.temporal?.count ?? seedCount;
      let tRank = 0;
      for (const p of dated) {
        if (tRank >= cap) break;
        if (isReadable && !isReadable(p.path)) continue;
        const rows = db
          .prepare(
            "SELECT id, content FROM chunks WHERE vault_id = ? AND path = ? ORDER BY chunk_index",
          )
          .all(opts.vaultId, p.path) as Array<{ id: string; content: string }>;
        for (const r of rows) {
          if (tRank >= cap) break;
          temporalRankById.set(r.id, tRank);
          if (!seen.has(r.id)) {
            seen.add(r.id);
            candidates.push({
              chunk_id: r.id,
              path: p.path,
              content: r.content,
              source: "temporal",
              hop: 0,
              via_edge: null,
              root_seed: null,
              streamRank: tRank,
            });
          }
          tRank += 1;
        }
      }
    }
  }
  return {
    candidates,
    lexRankById,
    lexScoreById,
    sparseRankById,
    sparseScoreById,
    temporalRankById,
  };
}
