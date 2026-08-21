// THE-642 item 1: the semantic channel of hybrid work_search — fused with the existing lexical
// (LIKE) channel by Reciprocal Rank Fusion. This module is deliberately DUMB about authorization:
// it scores whatever candidate rows it is handed and knows nothing about eligibility, trust,
// tombstones, or the caller partition. work_search (tools/m8/experiential-tools.ts) is the only
// caller, and it is responsible for passing a candidate pool that has ALREADY passed every THE-238
// reader-contract clause — a KNN that bypassed those filters would be an authorization bug, not a
// feature, and keeping this module SQL-free (no Database handle) makes that bypass structurally
// impossible rather than merely a convention.
//
// RRF, not a new fusion scheme: `1/(rrfK + rank)` with the repo's own rrfK=10 default, the same
// formula and constant used by the three other fusion layers here — search/graph_search_stages/
// fusion.ts (in-query stream fusion), search/federated_search.ts (cross-vault), search/
// multi_query.ts (cross-variant). None of the three is reusable AS-IS: each is keyed to its own
// domain type (Candidate, vault+path, GraphSearchResult), so this module reimplements the same
// rank-based math against a bare episode id rather than forcing an adapter onto one of them.
//
// Deliberately QUERY-TIME, not a persisted vector index: agent_episodes.summary is written by a
// separate build (THE-752) and is NULL on most/all rows today, so a persisted index would sit
// empty and need its own migration + backfill policy before it earns its keep — the open question
// the THE-642 ticket itself left unresolved. Brute-force cosine over a BOUNDED candidate pool
// mirrors search/note-summaries.ts's identical "small N, brute force is fine" call, searches
// whatever summaries exist right now, and needs zero schema change. A persisted vec index is the
// natural follow-up once corpus + THE-752 make the candidate pool worth indexing.
//
// Concurrency (THE-616 discipline): the WHOLE bounded candidate pool is embedded in a SINGLE
// batched provider.embed() call, never one call per episode — exactly the "N sequential embedding
// calls" anti-pattern THE-616 removed elsewhere. The pool is capped by the caller (work_search),
// so this stays one bounded-size round trip regardless of corpus size.
import type { EmbeddingProvider } from "../embeddings/provider";
import { cosineSimilarity } from "../search/native";
import { createQueryEncoder } from "../search/query-encoder";

export interface EpisodeSemanticCandidate {
  id: string;
  summary: string | null;
}

/**
 * Rank an ALREADY reader-contract-filtered candidate pool by cosine similarity of `summary` to
 * `query`. Rows with a NULL or empty summary are skipped — they have nothing to embed, so they
 * simply do not appear in this stream. That is the "handle rows with no summary yet gracefully"
 * behaviour: such a row is still reachable through the lexical stream, it just carries no semantic
 * evidence. Returns episode ids in descending-score order (ties broken by id for a total order).
 *
 * Returns `[]` — never throws — when there is nothing embeddable, the provider errors, or the
 * provider yields no vector for the query: a provider outage degrades hybrid search to
 * lexical-only rather than failing the whole work_search call.
 */
export async function semanticRankEpisodes(
  provider: EmbeddingProvider,
  query: string,
  candidates: EpisodeSemanticCandidate[],
): Promise<string[]> {
  const embeddable = candidates.filter(
    (c): c is EpisodeSemanticCandidate & { summary: string } =>
      typeof c.summary === "string" && c.summary.length > 0,
  );
  if (embeddable.length === 0) return [];

  let queryVec: number[];
  let docVecs: number[][];
  try {
    // Two provider round trips total (one query, one batched document call) regardless of pool
    // size — never one call per candidate. The query goes through the canonical query-encoder (the
    // ONE sanctioned single-query dense encode in the tree — query-encoder.test.ts enforces it),
    // not a raw provider.embed([query]).
    const [qv, docs] = await Promise.all([
      createQueryEncoder(provider).dense(query),
      provider.embed(
        embeddable.map((c) => c.summary),
        { input: "document" },
      ),
    ]);
    if (!qv || qv.length === 0) return [];
    queryVec = qv;
    docVecs = docs;
  } catch {
    return [];
  }

  const scored = embeddable
    .map((c, i) => ({
      id: c.id,
      score: cosineSimilarity(queryVec, Float32Array.from(docVecs[i] ?? [])),
    }))
    .filter((s) => Number.isFinite(s.score) && s.score > 0);
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.map((s) => s.id);
}

const DEFAULT_RRF_K = 10;

/**
 * Reciprocal Rank Fusion over N ranked id lists (rank is 1-based position within each list): every
 * id's fused score is Σ over the streams it appears in of `1/(rrfK + rank-in-that-stream)`. Same
 * formula and default k as this repo's other RRF layers — see this module's header. A local
 * reimplementation rather than an import: none of the three existing fusers is generic over a bare
 * id, each is keyed to its own domain's result type.
 */
export function fuseEpisodeRanks(streams: string[][], rrfK: number = DEFAULT_RRF_K): string[] {
  const score = new Map<string, number>();
  for (const stream of streams) {
    stream.forEach((id, i) => {
      const rank = i + 1;
      score.set(id, (score.get(id) ?? 0) + 1 / (rrfK + rank));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}
