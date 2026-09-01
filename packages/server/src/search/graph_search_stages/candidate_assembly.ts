// THE-465 "candidateAssembly" stage: merges the seed/expansion/lexical/sparse/temporal streams
// into one deduped Candidate[] (seeds win ties), recording each stream's per-chunk rank/score so
// the fusion stage can compute the additive cross-stream RRF bonus. Moved verbatim out of
// graphSearchCore's steps 4/4b/4c/4d — same ACL filtering (isReadable checks inline per stream,
// unreadable hits never consume a rank), same dedup-by-chunk_id-seeds-win order.
import type { Database } from "../../db/types";
import { allChunkPaths } from "../acl_path_set";
import type { LexicalHit } from "../chunk_fts";
import type { ClusterSummaryHit } from "../cluster-summaries";
import type { SummaryHit } from "../note-summaries";
import { filterChunksAsOf } from "../point_in_time";
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
  /** THE-628 (first PR): note-level summary hits, DARK — empty/undefined unless
   *  opts.summaries?.enabled (the caller in graph_search.ts never queries note_summaries
   *  otherwise, so this is genuinely absent, not merely empty, on the default config path). */
  summaryHits?: SummaryHit[];
  /** THE-628 (second PR): cluster-level (tier-2) summary hits, DARK — empty/undefined unless
   *  opts.summaries?.clusters?.enabled (the caller in graph_search.ts never queries
   *  cluster_summaries otherwise). Already ACL-filtered (searchClusterSummaries checks every
   *  MEMBER note's path) — see this file's merge block below for why that means no second,
   *  per-candidate isReadable(h.path) check here, unlike summaryHits above. */
  clusterSummaryHits?: ClusterSummaryHit[];
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
  const {
    db,
    opts,
    seedCount,
    seeds,
    expansionChunks,
    lexHits,
    sparseHits,
    summaryHits,
    clusterSummaryHits,
    onStage,
  } = input;
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
  // 4d. Note-summary stream (THE-628, first PR): DARK — `summaryHits` is only ever non-empty when
  // the caller (graph_search.ts) queried note_summaries under opts.summaries?.enabled, so this
  // loop is a true no-op (0 iterations) on the default config, not merely an empty result.
  // ACL-filtered by the SAME isReadable every other stream above uses: a summary whose source note
  // the caller cannot read is dropped here, before it ever becomes a candidate — the identical
  // discipline lexical/sparse apply to a chunk. Summary ids are synthetic (search/note-summaries.ts
  // noteSummaryId) and structurally cannot collide with a real chunk_id, so `seen` dedup against
  // the chunk streams above is safe by construction, not by luck.
  let summaryRank = 0;
  for (const h of summaryHits ?? []) {
    if (isReadable && !isReadable(h.path)) {
      continue;
    }
    if (!seen.has(h.chunk_id)) {
      seen.add(h.chunk_id);
      candidates.push({
        chunk_id: h.chunk_id,
        path: h.path,
        content: h.content,
        source: "summary",
        hop: 0,
        via_edge: null,
        root_seed: null,
        streamRank: summaryRank,
      });
    }
    summaryRank += 1;
  }
  // 4d-2. Cluster-summary stream (THE-628, second PR): DARK — `clusterSummaryHits` is only ever
  // non-empty when the caller (graph_search.ts) queried cluster_summaries under
  // opts.summaries?.clusters?.enabled, so this loop is a true no-op (0 iterations) on the default
  // config, exactly like 4d above.
  //
  // NO per-candidate `isReadable(h.path)` check here — deliberately, unlike every other stream in
  // this function. `h.path` on a cluster-summary hit is the cluster_key (searchClusterSummaries'
  // ClusterSummaryHit.path), NOT a real vault path; calling isReadable() on it would either throw
  // or (more likely, depending on the isReadable implementation) simply return false for every
  // cluster, which would silently disable this entire candidate stream rather than filter it
  // correctly. The mixed-ACL security filter for cluster summaries is NOT "can the caller read this
  // one path" — it is "can the caller read EVERY member note's path", which only
  // searchClusterSummaries has the member-path list to check (search/cluster-summaries.ts). By the
  // time a ClusterSummaryHit reaches this function, that check has ALREADY run; see
  // test/cluster-summaries.test.ts's SECURITY test for the mutation-tested proof that removing
  // THAT filter (not this one) is what reopens the leak.
  let clusterSummaryRank = 0;
  for (const h of clusterSummaryHits ?? []) {
    if (!seen.has(h.chunk_id)) {
      seen.add(h.chunk_id);
      candidates.push({
        chunk_id: h.chunk_id,
        path: h.path,
        content: h.content,
        source: "cluster_summary",
        hop: 0,
        via_edge: null,
        root_seed: null,
        streamRank: clusterSummaryRank,
      });
    }
    clusterSummaryRank += 1;
  }
  // 4e. Temporal stream (THE-221): conditional on explicit temporal intent in the query; empty
  //     otherwise, so non-temporal queries fuse exactly as before. Notes are matched by filename
  //     date inside the parsed range and ranked by proximity to the range midpoint; a chunk also
  //     found by another stream gets the additive RRF bonus below, like lexical/sparse.
  const temporalRankById = new Map<string, number>();
  if (opts.temporal?.enabled ?? false) {
    const range = parseTemporalIntent(opts.query, opts.temporal?.nowMs ?? Date.now());
    if (range) {
      const mid = (range.start + range.end) / 2;
      const dated = allChunkPaths(db, opts.vaultId)
        .map((path) => ({ path, date: noteDateMs(path) }))
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
  // 4f. THE-635 point-in-time PRE-filter (see GraphSearchOptions.asOf's doc): runs LAST, over the
  // fully-merged candidate set from every stream above, so it can never be bypassed by a stream
  // that assembles candidates its own way — a chunk excluded here never reaches fusion/ranking,
  // which is what makes this a pre-filter rather than a post-hoc drop of ranked results. Composes
  // WITH the ACL filtering each stream above already applied rather than instead of it: this pass
  // only ever REMOVES candidates that survived those checks, never readmits one they excluded.
  //
  // filterChunksAsOf's existence check is scoped to the `chunks` table, so a synthetic
  // "summary"/"cluster_summary" candidate (chunk_id is not a real chunk row — see those streams'
  // own comments above) is never present in its result and is therefore excluded here too: there
  // is no created_at/updated_at for a synthetic id to have "existed at D" against, so exclusion is
  // the honest answer, not an oversight.
  let finalCandidates = candidates;
  if (opts.asOf !== undefined) {
    const asOfChunks = filterChunksAsOf(db, opts.vaultId, {
      start: opts.since ?? 0,
      end: opts.asOf,
    });
    const changedSinceDById = new Map(asOfChunks.map((c) => [c.id, c.changedSinceD]));
    finalCandidates = candidates
      .filter((c) => changedSinceDById.has(c.chunk_id))
      .map((c) => ({ ...c, changedSinceD: changedSinceDById.get(c.chunk_id) }));
  }
  return {
    candidates: finalCandidates,
    lexRankById,
    lexScoreById,
    sparseRankById,
    sparseScoreById,
    temporalRankById,
  };
}
