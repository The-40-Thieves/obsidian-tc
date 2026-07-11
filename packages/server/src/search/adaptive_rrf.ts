// THE-391: per-query lexical-specificity signal for adaptive RRF stream weighting.
//
// Static equal-weight RRF treats the dense and lexical streams as equally trustworthy for every
// query. They are not: a query built from rare, specific terms ("Khaldunian Cycle") is exactly
// what BM25 / learned-sparse retrieval is precise at, while a common-vocabulary conceptual query
// ("themes of endurance and survival") is where the dense stream carries the signal. This module
// measures which kind of query we have.
//
// The signal is the mean normalized BM25-style IDF of the query's terms over the chunk_fts
// corpus. Document frequency is computed with a per-term MATCH count so each term is routed
// through the SAME FTS5 tokenizer as the BM25 stream (porter unicode61) — a raw vocabulary
// lookup would miss stemmed forms. Terms absent from the corpus are excluded from the mean:
// BM25 has no signal for them, so they must not tilt the fusion toward a stream that will find
// nothing.
//
// Returns a value in [0, 1] (0 = ubiquitous terms -> lean dense; 1 = unique terms -> lean
// lexical/sparse), or null when there is no usable signal (no FTS5 / empty corpus / no query
// term present in the corpus / no terms at all); callers keep neutral weights on null.
// Cost: at most MAX_TERMS indexed FTS lookups per query.
import type { Database } from "../db/types";
import { queryTerms } from "./chunk_fts";

// Bound the per-query FTS lookups; beyond this many distinct terms the mean is stable anyway.
// Deliberate tradeoff: terms past the cap (in query order) are never scored, so a rare term
// buried deep in a very long query can be missed — bounded cost wins over exhaustive scoring
// on an interactive search path.
const MAX_TERMS = 16;

export function querySpecificity(db: Database, vaultId: string, query: string): number | null {
  const terms = [...new Set(queryTerms(query))].slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  try {
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    if (n === 0) return null;
    const dfStmt = db.prepare(
      "SELECT COUNT(*) AS df FROM chunk_fts WHERE vault_id = ? AND chunk_fts MATCH ?",
    );
    // BM25 idf, normalized by its df->0 ceiling so a corpus-unique term sits near 1.
    const idfMax = Math.log(1 + (n + 0.5) / 0.5);
    let sum = 0;
    let present = 0;
    for (const t of terms) {
      const { df } = dfStmt.get(vaultId, `"${t}"`) as { df: number };
      if (df === 0) continue;
      sum += Math.log(1 + (n - df + 0.5) / (df + 0.5)) / idfMax;
      present += 1;
    }
    return present === 0 ? null : sum / present;
  } catch {
    // chunk_fts absent (FTS-less adapter / un-provisioned index) — no lexical signal.
    return null;
  }
}
