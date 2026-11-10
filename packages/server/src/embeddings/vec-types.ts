// Vector value types shared by the embedding providers (which PRODUCE them) and the search
// rerankers (which consume them). They live on the provider side of that edge: search imports
// embeddings, never the reverse (no-embeddings-imports-search-runtime).

/** bge-m3 ColBERT multi-vector (late-interaction): one row per token, `dim` floats per row. */
export type ColbertMatrix = number[][];

/** token id (string key) -> weight. Empty means "no sparse signal". */
export type SparseVec = Record<string, number>;
