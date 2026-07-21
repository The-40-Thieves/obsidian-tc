// THE-460: single source of truth for the vec_chunks "representation" — every constant that
// changes what a stored vector MEANS. ensureVecChunks (search/vec.ts) folds all of these, plus
// the embedding provider/model/dimensions, into one fingerprint string that gets persisted
// alongside the index; any change here makes the stored fingerprint stop matching, which forces
// a rebuild/rotate rather than silently serving vectors built under a stale representation.

/** The vec0 table's distance_metric. Bump/change this when the DDL's distance_metric changes
 *  (e.g. cosine -> l2) — stored distances are meaningless across a metric change. */
export const VEC_DISTANCE_METRIC = "cosine";

/** The current vec0 table shape generation (columns / partition+aux structure, see THE-277).
 *  Bump this when the CREATE VIRTUAL TABLE DDL's column set or partitioning changes, so a
 *  differently-shaped table is never mistaken for being up to date. */
export const VEC_SCHEMA_GEN = "partition+aux";

/** Bump when chunking logic changes what text ends up embedded (span boundaries, splitting
 *  strategy, merge heuristics, ...) — the vec index would otherwise mix vectors built from
 *  differently-chunked text. */
export const CHUNKER_VERSION = 1;

/** Bump when the THE-406 chunk-context enrichment (note-title + heading-breadcrumb prefix on the
 *  embedded/BM25 text) changes. Callers fold this in only when enrichment is ON — pass
 *  `enrichmentVersion: chunkContext ? ENRICHMENT_VERSION : 0` — so toggling chunkContext itself
 *  also changes the fingerprint and triggers a rebuild. */
export const ENRICHMENT_VERSION = 1;

/** Everything that determines what a vector in vec_chunks actually represents. Two indexes are
 *  interchangeable iff every field here matches. */
export interface VecFingerprint {
  provider: string;
  model: string;
  dimensions: number;
  distanceMetric: string;
  enrichmentVersion: number;
  chunkerVersion: number;
  schemaGen: string;
  /** Optional extra disambiguator (e.g. a provider/model revision or checkpoint id) when one is
   *  readily available; omitted otherwise. */
  revision?: string;
}

/** Stable canonical string for a VecFingerprint — persisted in vec_index_fingerprint and compared
 *  on every ensureVecChunks call. Field order is fixed; any field's value changing changes the
 *  string, which is exactly the rebuild trigger. */
export function vecFingerprint(f: VecFingerprint): string {
  return [
    f.provider,
    f.model,
    String(f.dimensions),
    f.distanceMetric,
    String(f.enrichmentVersion),
    String(f.chunkerVersion),
    f.schemaGen,
    f.revision ?? "",
  ].join("|");
}
