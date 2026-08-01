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

/** Upper bound on rows examined when an ACL is supplied — see the note in `termDf`. */
const DF_SCAN_CAP = 200;

/**
 * Document frequency of one term over the enriched BM25 index (0 on any FTS failure), counted over
 * the chunks THIS CALLER CAN READ.
 *
 * THE-691 (security): this previously counted every match with no ACL, and the number reached
 * callers verbatim — `routeQuery` embeds it as `rare-term:<token>(df=<n>)`, and `route.signals` is
 * returned by vault_graph_search, knowledge_search, vault_context and reflect. Any caller holding
 * `read:notes` could probe a term and learn, from an ordinary successful response, whether it
 * occurs in notes they are denied and in how many chunks. A CONTENT-membership oracle, not merely
 * a path one.
 *
 * Counting readable rows fixes both halves: the reported number stops describing hidden content,
 * and the routing DECISION stops resting on evidence the caller cannot see — a term that is
 * rare-but-invisible should not send them down the lexical arm.
 *
 * Bounded, because this sits on the routing path ahead of every search. The decision only needs to
 * know whether the readable count lands in [1, rareDfMax], so the scan exits as soon as it exceeds
 * that and never examines more than DF_SCAN_CAP rows. Residual case — more than DF_SCAN_CAP
 * matches with every readable one beyond the cap — under-counts and declines to route lexical.
 * That is a recall limit and it fails CLOSED: a missed lexical route costs a cheaper path, never a
 * disclosure.
 *
 * Without `isReadable` the fast COUNT(*) is kept, so non-ACL callers pay nothing.
 */
function termDf(
  db: Database,
  vaultId: string,
  term: string,
  isReadable?: (path: string) => boolean,
  rareDfMax = 3,
): number {
  const quoted = `"${term.replace(/"/g, "")}"`;
  try {
    if (!isReadable) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE vault_id = ? AND chunk_fts MATCH ?")
        .get(vaultId, quoted) as { n: number } | undefined;
      return row?.n ?? 0;
    }
    const rows = db
      .prepare("SELECT path FROM chunk_fts WHERE vault_id = ? AND chunk_fts MATCH ? LIMIT ?")
      .all(vaultId, quoted, DF_SCAN_CAP) as Array<{ path: string }>;
    let n = 0;
    for (const r of rows) {
      if (!isReadable(r.path)) continue;
      n++;
      // Past the rare window the exact value is irrelevant to every caller of this function.
      if (n > rareDfMax) return n;
    }
    return n;
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
  opts: {
    nowMs?: number;
    rareDfMax?: number;
    /** THE-691: the caller's read predicate. Without it the rare-term signal — and the routing
     *  decision itself — are computed over content the caller may not be allowed to see, and the
     *  signal is returned to them verbatim. Every tool call site supplies it. */
    isReadable?: (path: string) => boolean;
  } = {},
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
      const df = termDf(db, vaultId, t, opts.isReadable, rareDfMax);
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
