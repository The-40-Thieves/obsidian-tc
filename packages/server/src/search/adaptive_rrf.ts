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

/**
 * THE-853 (security): `n` and `df` are corpus-wide counts, `WHERE vault_id = ?` only, with no ACL
 * partition — a restricted caller whose ranking is tilted by this signal is being handed a term's
 * document frequency computed over notes they cannot read. A term that occurs only in unreadable
 * notes reports `df` from those notes; the specificity value derived from it still reorders the
 * caller's OWN results, so the tilt itself is a cross-ACL term-presence oracle: query a rare term,
 * watch adaptive RRF pull the lexical/sparse streams up or down, learn the term's whole-vault
 * frequency without ever seeing a hit for it. Same root shape as THE-287 (dense)/THE-632
 * (lexical+sparse)/THE-852 (graph walk) — an aggregate computed over the whole corpus and exposed,
 * via ranking rather than content, to a caller who sees only part of it.
 *
 * Fix mirrors `resolveAclWalkFilter`'s fail-closed disambiguation (retrieval-runtime.ts):
 *   - `blocked` true (caller is RESTRICTED and no `acl_path_members` set could be resolved) ->
 *     `null` unconditionally, before either count runs. There is no aclSetId to join on, so
 *     computing anything here would mean the whole-corpus stat leaks exactly as before; `null`
 *     disables adaptive RRF for the query and callers already fall back to neutral (1/1/1) weights
 *     on `null`, same as "no signal" today.
 *   - `aclSetId` present -> `n` and each term's `df` are joined to `acl_path_members` on that set,
 *     so the signal is computed over exactly the notes this caller can read.
 *   - neither (unrestricted caller, nothing to filter) -> unchanged whole-corpus counts, byte-
 *     identical to before this ticket.
 */
export function querySpecificity(
  db: Database,
  vaultId: string,
  query: string,
  aclSetId?: number,
  blocked?: boolean,
): number | null {
  if (blocked) return null;
  const terms = [...new Set(queryTerms(query))].slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  try {
    // THE-711 follow-up: chunk_fts is contentless, so `WHERE chunk_fts.vault_id = ?` matches
    // NOTHING and returns 0 without erroring — which here would have silently disabled adaptive
    // RRF rather than failing loudly. The corpus size comes from `chunks` instead: the two are
    // 1:1 by construction (ensureChunkFts rebuilds on any count divergence), and `chunks` has an
    // index on (vault_id, path) where the old FTS scan had none.
    const nStmt =
      aclSetId === undefined
        ? db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?")
        : db.prepare(
            "SELECT COUNT(*) AS n FROM chunks JOIN acl_path_members a ON a.set_id = ? AND a.path = chunks.path WHERE chunks.vault_id = ?",
          );
    const { n } = (aclSetId === undefined ? nStmt.get(vaultId) : nStmt.get(aclSetId, vaultId)) as {
      n: number;
    };
    if (n === 0) return null;
    // df still needs the FTS table for MATCH; the join resolves the vault (and, when aclSetId is
    // present, the caller's permitted-path set — same JOIN shape bm25Chunks' aclSetId branch uses,
    // MATCH narrows first so the join is over matched rows rather than the corpus).
    const dfStmt =
      aclSetId === undefined
        ? db.prepare(
            "SELECT COUNT(*) AS df FROM chunk_fts JOIN chunks ON chunks.rowid = chunk_fts.rowid WHERE chunks.vault_id = ? AND chunk_fts MATCH ?",
          )
        : db.prepare(
            "SELECT COUNT(*) AS df FROM chunk_fts JOIN chunks ON chunks.rowid = chunk_fts.rowid JOIN acl_path_members a ON a.set_id = ? AND a.path = chunks.path WHERE chunks.vault_id = ? AND chunk_fts MATCH ?",
          );
    // BM25 idf, normalized by its df->0 ceiling so a corpus-unique term sits near 1.
    const idfMax = Math.log(1 + (n + 0.5) / 0.5);
    let sum = 0;
    let present = 0;
    for (const t of terms) {
      const { df } = (
        aclSetId === undefined
          ? dfStmt.get(vaultId, `"${t}"`)
          : dfStmt.get(aclSetId, vaultId, `"${t}"`)
      ) as { df: number };
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
