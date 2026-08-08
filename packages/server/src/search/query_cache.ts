// THE-497 — the query-product cache.
//
// Caches the expensive-but-reusable products of a retrieval (the query's dense/sparse/ColBERT
// encodings, and the whole graph-search result) under a key that binds BOTH halves of THE-496:
//
//   1. IDENTITY — the caller's ACL fingerprint (acl.ts). Two callers with different effective read
//      sets never share an entry, so the cache can never serve caller A's content to caller B. An
//      incorrect key here is a data leak of the same class as THE-453/THE-456, which is why this is
//      part of EVERY key in this file, even for products that do not depend on vault content: it
//      costs only cross-principal hit rate (nothing at all in a single-principal runtime) and it
//      also closes the timing side channel where B learns that A asked the same question.
//   2. STALENESS — the vault generation (generation.ts). The bump lives inside each index write
//      transaction, and the design deliberately errs toward bumping: a missed bump would silently
//      serve stale results, while an over-bump is merely a cache miss. This cache inherits that
//      asymmetry rather than re-deriving it.
//
// Two design decisions worth keeping:
//
// * THE KEY IS STRUCTURAL, NOT ENUMERATED. GraphSearchOptions carries ~30 knobs and grows most
//   months. A hand-listed key would silently stop covering the next one added, and the failure mode
//   is serving a result computed under a DIFFERENT configuration — invisible, and wrong. So the key
//   hashes the whole options object generically (hashInto below); a new option participates the day
//   it is added, with no edit here. `query-cache-key-coverage.test.ts` is the gate that proves it.
// * THE KEY DOES NOT CONTAIN THE QUERY VECTORS. It contains the query TEXT plus a REPRESENTATION
//   descriptor (what a vector means: provider/model/dimensions + which streams are on). Keying on
//   the vectors would be circular — computing them is the expensive part we are trying to skip, so
//   a cache that needs them first can only save the DB work, never the model round-trip. Vectors
//   are a pure function of (text, representation), so this is exact, not an approximation.
import { createHash, type Hash } from "node:crypto";
import type { Database } from "../db/types";
import { graphSearch } from "./graph_search";
import type { GraphSearchOptions, GraphSearchResult } from "./graph_search_stages/types";

/** Cache-key namespace per product, so two products can never collide on one key. */
const PRODUCT_GRAPH_SEARCH = "THE-497/graph_search";
const PRODUCT_QUERY_VECTORS = "THE-497/query_vectors";

/** A function's IDENTITY is deliberately not part of any key — see `FUNCTION_FIELDS` below. One
 *  more type tag in hashInto's alphabet (N/U/T/F/D/G/S/Y/V/A/O), distinct from all of them, so a
 *  function is distinguishable from every other value and indistinguishable from another function. */
const FN_SENTINEL = "X";

export interface QueryCacheStats {
  hits: number;
  misses: number;
  stores: number;
  /** Entries dropped because the cache was full (LRU). */
  evictions: number;
  /** Entries found past their TTL — either on `get()` (a miss) or swept proactively at the front of
   *  `set()` before the LRU cap runs (THE-626). Both prove the TTL is doing work; kept separate from
   *  `evictions` because an expiry and a capacity eviction mean different things about cache sizing. */
  expirations: number;
}

export interface QueryCacheOptions {
  /** Hard cap on live entries. Retrieval results carry chunk CONTENT, so this bounds memory. */
  maxEntries: number;
  /** Entry lifetime. A TTL is required, not optional: several inputs to a retrieval are
   *  wall-clock dependent and invisible to the key — `decay.nowMs` / `temporal.nowMs` default to
   *  Date.now() INSIDE graphSearch when the caller omits them, and derived state (densified edges,
   *  activation scores) is written by jobs that do not bump the vault generation. The TTL is the
   *  only thing bounding how stale any of those can make an entry. */
  ttlMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * A bounded LRU cache with a TTL. Deliberately tiny and dependency-free: correctness here lives in
 * the KEY (above), not in the eviction policy.
 */
export class QueryCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private stores = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(opts: QueryCacheOptions) {
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) {
      throw new Error(`QueryCache maxEntries must be a positive integer, got ${opts.maxEntries}`);
    }
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new Error(`QueryCache ttlMs must be a positive number, got ${opts.ttlMs}`);
    }
    this.maxEntries = opts.maxEntries;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }
    // Re-insert to move the key to the tail: Map iterates in insertion order, so the FIRST key is
    // the least recently used one evict() drops.
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hits++;
    return hit.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    // THE-626: sweep one expired entry before growing the map. Without this, an entry that expires
    // and is never re-requested just sits at the front — get() is the only other place that checks
    // expiresAt, and only for the key actually asked for — until ordinary capacity pressure evicts
    // it. That eviction lands on the right entry often enough to hide the bug, but it is charged as
    // an LRU eviction rather than an expiration, and in the meantime the dead entry occupies a slot
    // a live one could have used instead. Map iterates in insertion order and get() only reorders on
    // a HIT, so the front is the least-recently-touched entry — a good proxy for "expired", though
    // not a proof: an entry can be touched (moved to the back) without its expiresAt moving with it,
    // so this does not catch every dead entry. A single check is O(1) amortised; scanning the whole
    // map on every store is not worth the extra correctness for a cache this size (see the ticket).
    const front = this.entries.keys().next();
    if (!front.done) {
      const frontEntry = this.entries.get(front.value);
      if (frontEntry && frontEntry.expiresAt <= this.now()) {
        this.entries.delete(front.value);
        this.expirations++;
      }
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.stores++;
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions++;
    }
  }

  /** Drop everything. Used by tests and by any caller that would rather pay a miss than reason
   *  about whether an entry is still sound. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): QueryCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      stores: this.stores,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }
}

/**
 * What a query vector MEANS — the serve-side twin of search/representation.ts's VecFingerprint.
 * Two encodings are interchangeable iff every field here matches, so this is what lets the cache
 * key carry the query TEXT instead of the vectors themselves.
 *
 * `sparse`/`colbert` are here and not merely implied by the options object because they decide
 * whether `embed()` produces those heads at all — a run with the sparse stream on and one with it
 * off are different products of the same text and must not share an entry.
 */
export interface RepresentationDescriptor {
  /** EmbeddingProvider.id — the configured provider instance. */
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  sparse: boolean;
  colbert: boolean;
}

/** The per-dispatch half of the key: who is asking (ACL) and what the vault looked like. */
export interface QueryCacheBinding {
  /** THE-496 `aclFingerprint(config, grantedScopes)` for THIS caller and vault. */
  aclFingerprint: string;
  /** THE-496 `readGeneration(db, vaultId)` — 0 on a pre-migration cache.db, which is safe: a
   *  never-bumping generation degrades this to a TTL-only cache, it never widens the key. */
  generation: number;
  representation: RepresentationDescriptor;
}

/** The query-side products of one retrieval — everything derivable from (text, representation). */
export interface QueryVectors {
  queryVec: number[];
  querySparse?: GraphSearchOptions["querySparse"];
  queryColbert?: GraphSearchOptions["queryColbert"];
}

/** The stores, held once per process. Absent -> every path below is an exact no-op. */
export interface RetrievalCaches {
  results: QueryCache<GraphSearchResult[]>;
  vectors: QueryCache<QueryVectors>;
}

export function createRetrievalCaches(opts: QueryCacheOptions): RetrievalCaches {
  return { results: new QueryCache(opts), vectors: new QueryCache(opts) };
}

// The option fields that hold FUNCTIONS. Their identity is not hashable, so hashInto folds each to
// one sentinel — meaning "a function is here; which one is not part of the key". Every entry below
// is a reviewed claim that this is sound, and query-cache-key-coverage.test.ts fails if a new
// function-valued field appears without being added here and reviewed:
//
//   isReadable     — the read predicate. Purely a function of (ACL config, granted scopes), which
//                    IS in the key as the ACL fingerprint. This is the isolation guarantee.
//   activationFor  — a DB lookup of cached_activation_score. RE-REVIEWED for THE-424 Part A, which
//                    wired bubbleSafe into the serve path: this entry used to lead with "inert
//                    unless bubbleSafe.enabled", and that clause is now false whenever an operator
//                    sets experiential.activationRerank. The claim that survives, and the whole
//                    argument today: what the sentinel drops is the lookup's IDENTITY, and identity
//                    is not what varies — one process holds exactly one activationFor, built once
//                    from config (runtime/stores.ts). What varies is the VALUES it returns, since
//                    recomputeActivation rewrites cached_activation_score without bumping the
//                    generation. So a cache hit inside the TTL can serve an order computed from
//                    pre-recompute activation. That is bounded twice over — the bubble pass moves
//                    any item at most one position, and the TTL bounds how stale the scores can be
//                    (documented above).
//                    CORRECTED after THE-424 Part B: this used to end "never a wrong result set",
//                    reasoning that a one-position bound cannot change top-K MEMBERSHIP. It can.
//                    An item at rank K+1 moving to rank K is a one-position move that swaps a
//                    document into the returned set. Measured on the public evergreen corpus: zero
//                    membership changes at the 512-token chunk budget, but 1-2 queries of 78 at 256,
//                    because denser chunks crowd the rank-K boundary. The POSITION bound held in
//                    both; the set-invariance was a property of that corpus at that budget, never of
//                    the mechanism. So the honest bound is: at most one adjacent swap, which at fine
//                    chunk budgets may mean one document entering or leaving the top-K. Accepted deliberately: keying on
//                    activation values would invalidate the whole cache on every recompute, which
//                    costs more than the one-slot drift it would fix. If the bubble pass ever
//                    becomes a full re-sort, this trade dies and activation must enter the key.
//   onStage        — observability only, cannot change results.
//   onStageMetric  — observability only, cannot change results.
//   onFusionWeights— observability only (THE-538 policy provenance), cannot change results. Note
//                    it reports weights that are already a pure function of keyed inputs
//                    (adaptiveRrf + query + vaultId), so nothing it observes is unkeyed.
//   onVecFallback  — observability only (THE-585 vec0->brute-force counter), cannot change results.
//                    Worth stating explicitly since this one reports a fact about HOW the search
//                    ran rather than what it returned: both paths produce the same ranked hits, so
//                    two calls differing only in their fallback sink must share a cache entry. A
//                    consequence to be aware of rather than a defect: a cache HIT skips the search
//                    entirely, so it also skips any fallback it would have taken — the counter
//                    measures executed searches, not requested ones.
//   onCoverage     — observability only (THE-631 coverage/confidence estimate), reported, never
//                    read back into scoring or ordering — same non-behavioral shape as
//                    onFusionWeights. Same cache-HIT caveat as onVecFallback above: a hit never
//                    calls graphSearch, so onCoverage does not fire and the tool-layer response
//                    simply omits `coverage` (the schema field is optional for exactly this).
//   reranker       — a bare `(query, docs, topN) => hits` function with no identity to hash. It is
//                    built once per process from config, so swapping it mid-process is not a thing
//                    that happens today; the key records only whether one is PRESENT, since absent
//                    vs present does change results. Give Reranker a stable id and this becomes
//                    exact.
//   onRerankOutcome— observability only: reports WHY the returned ranking is what it is
//                    (not_configured / skipped_by_policy / executed / timed_out /
//                    malformed_response / provider_error / fallback_used) and cannot change the
//                    ranking itself — `rerankWithScores` decides the outcome and then reports it.
//                    Two calls differing only in this sink must share a cache entry.
//                    Same cache-HIT caveat as onVecFallback/onCoverage, and it bites hardest here:
//                    a hit skips the rerank decision entirely, so the counter measures rerank
//                    decisions on EXECUTED searches, not on requested ones. A high cache hit rate
//                    therefore suppresses this metric without the reranker's health changing —
//                    read it alongside the cache's own hit/miss counters, never alone.
const FUNCTION_FIELDS = [
  "isReadable",
  "activationFor",
  "onStage",
  "onStageMetric",
  "onFusionWeights",
  "onVecFallback",
  "onCoverage",
  "onRerankOutcome",
  // THE-632 — onRetrievalTrace: diagnose_retrieval's per-note trace sink. Same reasoning as every
  // sink above: it is a pure side-channel that cannot change results, so two calls differing only
  // in it must share a cache entry.
  "onRetrievalTrace",
] as const;

/** THE-632: `traceNotePath` selects which note the trace FOLLOWS. It never filters, boosts or
 *  reorders — results are byte-identical with it set, unset, or pointed at a different note.
 *
 *  CORRECTION (cross-vendor review): an earlier version of this comment said the field was
 *  "deliberately UNKEYED". It is not. `graphSearchKey` deletes only DERIVED_VECTOR_FIELDS and
 *  normalizes `reranker`; FUNCTION_FIELDS drop out because JSON serialization discards functions,
 *  but `traceNotePath` is a STRING and therefore lands in the key. This list is the declaration of
 *  intent that the coverage gate reads, not a filter the key applies.
 *
 *  That mismatch is inert rather than wrong: `cachedGraphSearch` bypasses the cache outright
 *  whenever tracing is set, so the fragmenting entries the comment worried about are never written.
 *  Anyone making tracing cacheable must strip this field in `graphSearchKey` as well as listing it
 *  here — listing it here alone does nothing.
 *
 *  The cache-HIT caveat bites harder here than for the sinks, so it is written down rather than
 *  left to be rediscovered: a hit returns the cached results WITHOUT running the pipeline, so no
 *  trace records are produced and the caller sees an empty trace for a search that "worked". That
 *  is why `diagnose_retrieval` calls `graphSearch` DIRECTLY and never `cachedGraphSearch`. Anyone
 *  wiring tracing into the cached path must handle that explicitly — a silently empty trace reads
 *  as "the note was never anywhere", which is a wrong answer, not a missing one. */
const TRACE_SELECTOR_FIELDS = ["traceNotePath"] as const;

/** THE-631 item 2: fields that PARAMETERISE the coverage estimate and nothing else.
 *
 *  `staleThresholdDays` sets the age past which a returned note counts toward
 *  `CoverageEstimate.staleReturned`. It reaches exactly one place — `countStaleNotes`, whose output
 *  is handed to `estimateCoverage` and reported through `onCoverage`. It never touches seeds,
 *  expansion, fusion, diversity, rerank or projection, so two calls differing only in it return
 *  BYTE-IDENTICAL results and must share a cache entry.
 *
 *  Unlike TRACE_SELECTOR_FIELDS above, this does NOT bypass the cache, so it is stripped in
 *  `graphSearchKey` rather than merely listed here — keeping it in the key would fragment the cache
 *  by a knob that cannot change what is cached. Listing without stripping does nothing; see the
 *  trace note above for the same warning.
 *
 *  The cache-HIT caveat is the mildest in this file: a hit never calls `graphSearch`, so
 *  `onCoverage` does not fire and the tool layer omits `coverage` entirely (the schema field is
 *  optional for exactly this). A stale threshold therefore cannot produce a WRONG staleness count
 *  from cache — only an absent one, which is already the documented behaviour for every coverage
 *  field.
 *
 *  THE-733 adds `scoreCalibration` and `engineVersion` on the same grounds. Both reach exactly one
 *  place — `confidenceFor`, whose output is the `confidence` field of the coverage estimate — and
 *  nothing downstream of it touches scoring, fusion or ordering. Two searches differing only in
 *  which calibration row was current return byte-identical RESULTS and must share a cache entry;
 *  keying on them would fragment the cache every time a vault is recalibrated, for no change in
 *  what is cached. */
const COVERAGE_ONLY_FIELDS = ["staleThresholdDays", "scoreCalibration", "engineVersion"] as const;

/** Fields excluded from the key because they are derived from (query text, representation), both
 *  of which the key already carries — see the header note on circularity. */
const DERIVED_VECTOR_FIELDS = ["queryVec", "querySparse", "queryColbert"] as const;

export { COVERAGE_ONLY_FIELDS, DERIVED_VECTOR_FIELDS, FUNCTION_FIELDS, TRACE_SELECTOR_FIELDS };

/**
 * Fold an arbitrary value into a hash, deterministically and injectively.
 *
 * Every value is tag-prefixed and every variable-length value length-prefixed, so no two distinct
 * structures can produce the same byte stream (without those, `["ab","c"]` and `["a","bc"]` hash
 * identically — a silent key collision between two different configurations).
 *
 * `undefined` object properties are SKIPPED rather than encoded, so `{k: undefined}` and `{}` hash
 * alike. That is deliberate and matches how the pipeline reads its options: every knob is
 * `opts.x ?? default`, so absent and explicitly-undefined are the same configuration.
 */
export function hashInto(h: Hash, v: unknown): void {
  if (v === null) {
    h.update("N");
    return;
  }
  switch (typeof v) {
    case "undefined":
      h.update("U");
      return;
    case "boolean":
      h.update(v ? "T" : "F");
      return;
    case "number": {
      // Bit-exact: 0.1+0.2 must not hash as 0.3, and -0 must not hash as 0.
      const buf = Buffer.allocUnsafe(8);
      buf.writeDoubleLE(v, 0);
      h.update("D");
      h.update(buf);
      return;
    }
    case "bigint":
      h.update("G");
      updateString(h, v.toString());
      return;
    case "string":
      h.update("S");
      updateString(h, v);
      return;
    case "function":
      h.update(FN_SENTINEL);
      return;
    case "symbol":
      h.update("Y");
      updateString(h, String(v));
      return;
  }
  if (ArrayBuffer.isView(v)) {
    h.update("V");
    updateLength(h, v.byteLength);
    h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    return;
  }
  if (Array.isArray(v)) {
    // Embeddings are number[] of 768–4096 elements and ColBERT matrices are arrays of those. JSON
    // would stringify every float; the raw little-endian buffer is exact and ~an order of magnitude
    // cheaper on the hot path.
    if (v.length > 0 && v.every((x) => typeof x === "number")) {
      h.update("AD");
      updateLength(h, v.length);
      h.update(Buffer.from(Float64Array.from(v as number[]).buffer));
      return;
    }
    h.update("A");
    updateLength(h, v.length);
    for (const el of v) hashInto(h, el);
    return;
  }
  // Plain object (and anything object-like): sorted own enumerable string keys.
  const obj = v as Record<string, unknown>;
  // FRAGILE: skipping `undefined` properties means `{k: undefined}` and `{}` hash IDENTICALLY
  // (pinned by query-cache.test.ts's "treats an explicitly-undefined property as absent" case).
  // That is safe only because every option today is read as `opts.x ?? default`, so absent and
  // explicitly-undefined already mean the same thing to the pipeline. It stops being safe the day a
  // new nullable GraphSearchOptions field is added where "explicitly undefined" and "omitted" are
  // supposed to differ: one call site passing it and another omitting it would then collide here and
  // share a cache entry across a real behavioural difference — with aclFingerprint riding in the
  // same key, that is a cross-principal leak, not just a stale read. `graphSearchKey`'s `reranker`
  // handling below is the pattern to copy for such a field: map it to an explicit sentinel
  // ("absent"/"present") instead of relying on this skip.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  h.update("O");
  updateLength(h, keys.length);
  for (const k of keys) {
    updateString(h, k);
    hashInto(h, obj[k]);
  }
}

function updateString(h: Hash, s: string): void {
  const buf = Buffer.from(s, "utf8");
  updateLength(h, buf.byteLength);
  h.update(buf);
}

function updateLength(h: Hash, n: number): void {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(n >>> 0, 0);
  h.update(buf);
}

/** sha256 hex over an arbitrary structure — the one key builder every product below shares. */
export function structuralKey(parts: unknown): string {
  const h = createHash("sha256");
  hashInto(h, parts);
  return h.digest("hex");
}

/** Key for the query-side encodings. No generation: an encoding of a TEXT cannot go stale when
 *  vault CONTENT changes. The ACL fingerprint is still in the key — see the header. */
export function queryVectorsKey(query: string, binding: QueryCacheBinding): string {
  return structuralKey([
    PRODUCT_QUERY_VECTORS,
    binding.aclFingerprint,
    binding.representation,
    query,
  ]);
}

/** Key for a whole graph-search result. Carries both halves of THE-496 plus the full option set. */
export function graphSearchKey(
  base: Omit<GraphSearchOptions, "queryVec">,
  binding: QueryCacheBinding,
  denseText: string,
): string {
  const keyed: Record<string, unknown> = { ...base };
  for (const f of DERIVED_VECTOR_FIELDS) delete keyed[f];
  // THE-631 item 2: parameterises the coverage estimate only, never the results — keeping it
  // would fragment the cache by a knob that cannot change what is cached.
  for (const f of COVERAGE_ONLY_FIELDS) delete keyed[f];
  // `reranker` is a bare function with no identity (see FUNCTION_FIELDS); record presence only.
  keyed.reranker = keyed.reranker == null ? "absent" : "present";
  return structuralKey([
    PRODUCT_GRAPH_SEARCH,
    base.vaultId,
    binding.aclFingerprint,
    binding.generation,
    binding.representation,
    denseText,
    keyed,
  ]);
}

// Results are handed out to callers that pack, sort and annotate them in place. Store and return
// COPIES so a caller mutating its own results can never rewrite what the next caller reads —
// the cheap structural half of the same rule FolderAcl's accessors follow.
//
// THE-626: GraphSearchResult is NOT flat — `via_edge` (graph_search_stages/types.ts) is itself an
// object, so a bare `{...r}` spread only protects the top-level fields; `via_edge` would still be
// the SAME object shared between the cached entry and every caller that ever read it, so one
// caller mutating it corrupts the entry for every later reader. Deep-copy that one field
// explicitly rather than reaching for a generic deep clone: it is the only nested field this type
// has today, and this runs on every hit AND every store (see :413/:423 below — a hot path a
// speculative general-purpose clone is not worth paying for on fields that are already flat.
// Exported for query-cache.test.ts's mutation test.
export function copyResults(results: GraphSearchResult[]): GraphSearchResult[] {
  return results.map((r) => ({ ...r, via_edge: r.via_edge ? { ...r.via_edge } : null }));
}

/** Everything the cache needs that is NOT already in the options object. */
export interface QueryCacheContext {
  caches: RetrievalCaches;
  binding: QueryCacheBinding;
  /**
   * The text ACTUALLY embedded for the dense arm. Normally `base.query`, but under THE-451 HyDE it
   * is the hypothetical answer while the raw query still rides `base.query` for the lexical arms —
   * two different products of the same tool call. It is a required field rather than one defaulting
   * to `base.query` precisely because the HyDE case is the one a default would get silently wrong.
   *
   * The vectors entry is keyed on it as a bundle, so a HyDE call re-encodes the sparse/ColBERT
   * heads it could in principle have reused. That costs hit rate on one opt-in path and keeps the
   * key a single obvious thing; splitting the bundle per head is the optimisation if it ever
   * matters.
   */
  denseText: string;
}

/**
 * graphSearch with the query-product cache in front of it.
 *
 * The lookup happens BEFORE `embed()` runs, so a hit skips the embedding round-trip(s) as well as
 * the DB work — that ordering is the entire performance point (see the header note on why the key
 * cannot contain the vectors). With `cache` absent this is exactly `graphSearch`, one extra await
 * deep.
 */
export async function cachedGraphSearch(
  db: Database,
  base: Omit<GraphSearchOptions, "queryVec">,
  embed: () => Promise<QueryVectors>,
  cache?: QueryCacheContext,
): Promise<GraphSearchResult[]> {
  // THE-632: tracing STRUCTURALLY bypasses the result cache. A cache hit returns stored results
  // without running the pipeline, so no trace records are produced and the caller receives an
  // EMPTY trace for a search that "worked" — which reads as "the note was never anywhere", a wrong
  // answer rather than a missing one. diagnose_retrieval calls graphSearch directly today, so this
  // never fires; it exists so the guarantee is enforced by the code rather than by remembering.
  // Bypassing (not throwing) keeps a future caller correct instead of broken.
  if (!cache || base.traceNotePath !== undefined) {
    const v = await embed();
    return graphSearch(db, { ...base, ...v });
  }
  const { caches, binding, denseText } = cache;

  const resultKey = graphSearchKey(base, binding, denseText);
  const cached = caches.results.get(resultKey);
  if (cached) return copyResults(cached);

  const vectorKey = queryVectorsKey(denseText, binding);
  let vectors = caches.vectors.get(vectorKey);
  if (!vectors) {
    vectors = await embed();
    caches.vectors.set(vectorKey, vectors);
  }

  const results = await graphSearch(db, { ...base, ...vectors });
  caches.results.set(resultKey, copyResults(results));
  return results;
}
