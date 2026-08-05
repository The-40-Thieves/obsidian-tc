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
//               round-trip entirely — the cheapest class, and the one this router was
//               designed around.
//   standard  — everything else falls through to the measured engine unchanged (whose
//               internal seed-strength router already handles the dense-vs-graph split).
//
// Later classes route here too: preference-intent → profile-first (THE-222's store) and
// experiential federation (THE-237) plug in as new branches, never as a rewrite.
//
// DARK by default (retrieval.classRouter). Gate: per-class AND aggregate non-inferiority on the
// golden set under the ship rule, else it stays dark like every other loser.
//
// The golden set is n=250, not the n=136 this comment used to name — it was expanded 2026-07-19
// and the stale figure survived here. Resolution is METRIC-SPECIFIC (THE-674, re-measured
// 2026-08-02 on the live bge-m3 store): MDE 0.035 on `ndcg_at_10`, 0.026 on `recall_at_10`, 0.022
// on `bridge_recall`, 0.055 on `mrr_at_10`, and 0.062 on `bridge_ndcg_at_10` — which is scored on
// n=103, not 250. Declare which metric this gate reads and its MDE BEFORE running, or a null means
// "below resolution" rather than "no effect". Full table: `packages/server/eval/README.md`.
//
// Note what this router is FOR when picking that metric: the lexical class short-circuits to BM25
// and skips the embedding round-trip, so the effect to look for is COST, not quality. Non-inferiority
// on quality is the bar to clear. `eval/run.ts` already accepts `--class-router` and applies the
// same rules as serve, so measuring it needs no new code.
//
// THE-705 — BUT "the router is a cost win" IS NOT ESTABLISHED, and this header used to imply it was.
// Only two of the three classes are cheaper-or-neutral. `temporal` routes to MORE work: it turns on
// a retrieval stream that is otherwise off, so it ADDS a stream rather than skipping one. Counted
// over the n=250 golden set on 2026-08-04 (deterministic — no timing involved):
//
//     standard  214  85.6%   unchanged
//     temporal   21   8.4%   MORE work  — extra stream enabled
//     lexical    15   6.0%   LESS work  — whole pipeline short-circuited
//
// That is 1.4 queries made more expensive for every 1 made cheaper. The net may still be favourable
// — a lexical short-circuit skips an embed AND seed generation AND expansion AND fusion, while
// temporal adds one stream to an already-running pipeline — but that is a timing question, and
// THE-510 records that this host cannot answer it (CV 0.822 against a 0.2 target). Quality came back
// non-inferior on all four metrics at an unusually tight resolution (nDCG MDE 0.0089), so the flag is
// safe to enable and simply not motivated. It stays dark until the temporal branch's cost is known.
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

/**
 * Document frequency of one term over the enriched BM25 index (0 on any FTS failure), counted over
 * the WHOLE vault.
 *
 * No ACL parameter, deliberately, and the paged readable-count scan that used to live here has been
 * DELETED rather than left reachable.
 *
 * THE-691 made the readable count exact by paging and filtering in JS, which closed the VALUE
 * channel: the emitted `rare-term:<token>(df=<n>)` signal and the routing class came to depend only
 * on permitted matches. THE-694 then measured the residual. With a restricted ACL, a term present
 * only in denied notes took a mean 3.381 ms against 0.047 ms for an absent term — both answering 0
 * — which is 72x with non-overlapping distributions. Latency still correlated with how much denied
 * content matched a caller-supplied token.
 *
 * No in-SQL predicate closes that. Joining a materialized permitted set plans as `SCAN chunk_fts
 * VIRTUAL TABLE` followed by a per-row membership probe, so the work stays proportional to TOTAL
 * matches however the filter is expressed; moving the scan out of JS makes it faster and
 * lower-variance, which is worse, not better. The only fix is to not ask the question, so
 * `routeQuery` issues this ONLY for callers who can read the whole vault — for whom a whole-vault
 * count discloses nothing they could not already retrieve.
 */
function termDf(db: Database, vaultId: string, term: string, rareDfMax = 3): number {
  const quoted = `"${term.replace(/"/g, "")}"`;
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE vault_id = ? AND chunk_fts MATCH ?")
      .get(vaultId, quoted) as { n: number } | undefined;
    const n = row?.n ?? 0;
    // Past the rare window the exact value is irrelevant to every caller of this function, so it is
    // clamped rather than returned — the signal string should not carry a precise corpus statistic.
    return n > rareDfMax ? rareDfMax + 1 : n;
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
    /** THE-694: true when the caller can read the whole vault (`readEnumerationUnrestricted`). The
     *  rare-term probe runs ONLY then. For a restricted caller it is skipped entirely — not
     *  filtered, not capped, not issued — because its LATENCY is the disclosure and no in-SQL
     *  predicate removes that. Restricted callers lose a ranking optimization, not correctness:
     *  they fall through to `standard`, the same path they took before the router existed. */
    readUnrestricted?: boolean;
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
  // THE-694: probe ONLY when the caller sees everything. `isReadable` absent means no ACL at all
  // (the eval harness and internal callers), which is likewise unrestricted.
  const mayProbe = opts.isReadable === undefined || opts.readUnrestricted === true;
  if (mayProbe && tokens.length > 0 && tokens.length <= 5) {
    const rareDfMax = opts.rareDfMax ?? 3;
    // THE-691: DEDUPE before slicing. A query repeating a token ("zarquon zarquon") would
    // otherwise run the same paged scan up to four times for one answer — pure waste, and it
    // multiplies the worst case (a term with many denied matches) by the repeat count.
    const candidates = [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, 4);
    for (const t of candidates) {
      const df = termDf(db, vaultId, t, rareDfMax);
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
  // THE-632: the ACL goes IN, so unreadable chunks never occupy slots inside the SQL limit and
  // crowd out readable ones. The post-filter below is kept because it is free.
  //
  // It is NOT a fail-closed backstop, and an earlier version of this comment claimed it was. Both
  // filters are conditional on the SAME optional argument, so a caller that omits `isReadable` gets
  // neither — the loop's guard is `isReadable && !isReadable(...)`, which is skipped entirely when
  // the argument is absent. What actually keeps this correct is that every production caller passes
  // it (verified repo-wide, THE-632). The API shape provides nothing; call-site coverage does.
  const hits = bm25Chunks(
    db,
    vaultId,
    query,
    Math.max(k * 2, k),
    ...(isReadable ? ([isReadable] as const) : ([] as const)),
  );
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
