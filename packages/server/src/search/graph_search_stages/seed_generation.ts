// THE-465 "seedGeneration" stage: vector seeds + lexical (BM25) seeds + learned-sparse seeds.
// Moved verbatim out of graphSearchCore's steps 1/1b/1c — same query shapes, same defaults
// (lexical.enabled ?? true, counts default to seedCount), same early-empty semantics preserved
// by the caller (empty seeds/lexHits/sparseHits still short-circuits graphSearchCore).
import type { Database } from "../../db/types";
import { bm25Chunks, type LexicalHit } from "../chunk_fts";
import { type SemanticHit, semanticSearch } from "../semantic";
import { type SparseHit, type SparseVec, sparseSearch } from "../sparse";
import type { GraphSearchOptions } from "./types";

export interface SeedGenerationInput {
  db: Database;
  opts: GraphSearchOptions;
  seedCount: number;
}

export interface SeedGenerationResult {
  seeds: SemanticHit[];
  lexHits: LexicalHit[];
  sparseHits: SparseHit[];
}

/** 1. Vector seeds. semanticSearch returns cosine as `score`, descending.
 *  1b. Lexical seeds (THE-73): chunk-level BM25 stream — empty when chunk_fts is absent or the
 *      query has no usable term. Fetched up front so a pure-lexical query (exact term, no vector
 *      seed) is not dropped by the seeds-empty early return in the caller.
 *  1c. Learned-sparse seeds (THE-388): bge-m3 lexical_weights stream — empty unless the caller
 *      supplies the query's sparse weights AND chunk_sparse holds data. */
export function generateSeeds(input: SeedGenerationInput): SeedGenerationResult {
  const { db, opts, seedCount } = input;
  const isReadable = opts.isReadable;
  const seeds = semanticSearch(db, opts.vaultId, opts.queryVec, {
    k: seedCount,
    returnContent: true,
    ...(isReadable ? { isReadable } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    // THE-585: forward the vec0 -> brute-force degradation signal. Absent by default.
    ...(opts.onVecFallback ? { onFallback: opts.onVecFallback } : {}),
  });
  // THE-632 (security): the read ACL is threaded into the lexical and sparse arms HERE, at query
  // time — not left to candidate_assembly. Filtering downstream removes unreadable hits from the
  // RESULTS but not from the counts, and any aggregate over these arrays (a diagnostic's
  // candidatesIn, for instance) then leaks their existence: query a rare term, watch the count
  // move, learn it appears in a note you cannot read. It also lets unreadable chunks crowd out
  // readable ones inside each arm's own top-k. The dense arm above has had this since THE-287;
  // these two never did.
  //
  // THE-853: `bm25Chunks` has carried an `aclSetId` param (THE-695) that turns the ACL check into
  // an exact SQL join + LIMIT instead of the over-fetch-then-JS-filter fallback below — this call
  // site never passed it, so a restricted caller always took the fallback and its residual
  // length-interference channel (see chunk_fts.ts's header comment on bm25Chunks). Threading
  // `opts.aclSetId` closes that for a caller whose set resolved. But an undefined `aclSetId` is
  // NOT uniformly safe: it means "no join" — correct for an unrestricted caller (nothing to hide),
  // a LEAK for a restricted caller whose set could not be resolved (`aclWalkFilter.blocked`), since
  // the fallback is the exact over-fetch channel this ticket closes. So fail that caller CLOSED to
  // `[]` rather than letting it reach the fallback — matching the blocked guard on the lexical
  // route and the lesson backfill.
  const lexicalEnabled = opts.lexical?.enabled ?? true;
  const lexBlocked = opts.aclWalkFilter?.blocked === true;
  const lexHits: LexicalHit[] =
    lexicalEnabled && !lexBlocked
      ? bm25Chunks(
          db,
          opts.vaultId,
          opts.query,
          opts.lexical?.count ?? seedCount,
          isReadable,
          opts.aclSetId,
        )
      : [];
  const sparseHits: SparseHit[] = opts.querySparse
    ? sparseSearch(
        db,
        opts.vaultId,
        opts.querySparse as SparseVec,
        opts.sparseCount ?? seedCount,
        ...(isReadable ? ([isReadable] as const) : ([] as const)),
      )
    : [];
  return { seeds, lexHits, sparseHits };
}
