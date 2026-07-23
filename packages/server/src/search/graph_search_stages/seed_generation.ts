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
  });
  const lexicalEnabled = opts.lexical?.enabled ?? true;
  const lexHits: LexicalHit[] = lexicalEnabled
    ? bm25Chunks(db, opts.vaultId, opts.query, opts.lexical?.count ?? seedCount)
    : [];
  const sparseHits: SparseHit[] = opts.querySparse
    ? sparseSearch(db, opts.vaultId, opts.querySparse as SparseVec, opts.sparseCount ?? seedCount)
    : [];
  return { seeds, lexHits, sparseHits };
}
