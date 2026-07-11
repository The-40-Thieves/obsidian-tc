// THE-258 — the federation query router, v1: deterministic rules over retrieval-confidence
// signals (the CA-RAG cost-aware strategy-bundle framing, arXiv 2606.02581), NOT a trained
// classifier — for a ~12k-chunk corpus with ~136 labeled queries, practitioners ship
// rule/threshold routers; the RAGRouter-Bench TF-IDF+entity-density classifier stays a later
// upgrade behind the same gate. The taxonomy comes from the measured golden-set classes:
//
//   temporal  — the precision-first temporal parser fires (THE-221): run the full graph WITH
//               the temporal stream enabled (measured Δ0.000 on non-temporal queries — the
//               parser never routes bare title-style dates, so this equals the static config
//               everywhere the intent is absent).
//   lexical   — exact-term shape (quoted phrase, or a short query carrying a corpus-rare
//               term): short-circuit to the enriched BM25 stream and SKIP the embedding
//               round-trip entirely — the cost win the router exists for.
//   standard  — everything else falls through to the measured engine unchanged (whose
//               internal seed-strength router already handles the dense-vs-graph split).
//
// Later classes route here too: preference-intent → profile-first (THE-222's store) and
// experiential federation (THE-237) plug in as new branches, never as a rewrite.
//
// DARK by default (retrieval.classRouter). Gate: per-class AND aggregate non-inferiority on
// the n=136 golden set under the ship rule, else it stays dark like every other loser.
import type { Database } from "../db/types";
import { bm25Chunks } from "./chunk_fts";
import type { GraphSearchResult } from "./graph_search";
import { parseTemporalIntent } from "./temporal";

export type RouteClass = "lexical" | "temporal" | "standard";

export interface RouteDecision {
  class: RouteClass;
  /** Which rules fired (auditable, e.g. "temporal-intent", "quoted-phrase", "rare-term:foo"). */
  signals: string[];
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "over",
  "what",
  "when",
  "where",
  "which",
  "does",
  "how",
  "why",
  "who",
  "are",
  "was",
  "were",
  "did",
  "about",
  "between",
]);

/** Document frequency of one term over the enriched BM25 index (0 on any FTS failure). */
function termDf(db: Database, vaultId: string, term: string): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE vault_id = ? AND chunk_fts MATCH ?")
      .get(vaultId, `"${term.replace(/"/g, "")}"`) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Classify one query. Deterministic and precision-first: only unmistakable shapes leave the
 * standard path, so a silent router equals the measured static engine exactly.
 */
export function routeQuery(
  db: Database,
  vaultId: string,
  query: string,
  opts: { nowMs?: number; rareDfMax?: number } = {},
): RouteDecision {
  const signals: string[] = [];

  // Temporal intent (THE-221 parser: prepositioned months/years, ISO dates, relative forms;
  // bare title-style dates never route).
  if (parseTemporalIntent(query, opts.nowMs ?? Date.now()) !== null) {
    signals.push("temporal-intent");
    return { class: "temporal", signals };
  }

  // Exact-term shapes: a quoted phrase is an explicit lexical request.
  if (/"[^"]{3,}"/.test(query)) {
    signals.push("quoted-phrase");
    return { class: "lexical", signals };
  }

  // Short query carrying a corpus-rare term (df in [1, rareDfMax]): the enriched BM25 stream
  // finds it directly; df=0 means the term is absent and lexical would return nothing, so it
  // stays standard.
  const tokens = (query.toLowerCase().match(/[a-z0-9_][a-z0-9_-]{3,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
  if (tokens.length > 0 && tokens.length <= 5) {
    const rareDfMax = opts.rareDfMax ?? 3;
    const candidates = [...tokens].sort((a, b) => b.length - a.length).slice(0, 4);
    for (const t of candidates) {
      const df = termDf(db, vaultId, t);
      if (df >= 1 && df <= rareDfMax) {
        signals.push(`rare-term:${t}(df=${df})`);
        return { class: "lexical", signals };
      }
    }
  }

  return { class: "standard", signals };
}

/**
 * The lexical short-circuit: enriched BM25 top-k projected to the graph result shape
 * (source "lexical", hop 0), ACL-filtered. Callers skip the embedding round-trip entirely.
 * Positional score (1/(1+i)) — the bubble pass and consumers treat it like a fused score.
 */
export function lexicalRouteResults(
  db: Database,
  vaultId: string,
  query: string,
  k: number,
  isReadable?: (path: string) => boolean,
): GraphSearchResult[] {
  const hits = bm25Chunks(db, vaultId, query, Math.max(k * 2, k));
  const out: GraphSearchResult[] = [];
  for (const h of hits) {
    if (isReadable && !isReadable(h.path)) continue;
    out.push({
      chunk_id: h.chunk_id,
      path: h.path,
      content: h.content,
      source: "lexical",
      hop: 0,
      via_edge: null,
      root_seed: null,
      rerank_score: 1 / (1 + out.length),
    });
    if (out.length >= k) break;
  }
  return out;
}
