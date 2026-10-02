# Search Indexing & Query Cache

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## index-vault.ts — module overview

`indexVault` is WP3 slice 3 (docs/plans/2026-07-30-codebase-refactor-map.md): it was moved
verbatim out of `indexer.ts` — the whole-vault walk, two-phase batching (plan+embed outside any
transaction, apply a batch inside one), stale-note cleanup, edge reconciliation (literal +
derived), and aggregated `IndexStats`.

## index-vault.ts — DEFAULT_BATCH_MAX_NOTES / DEFAULT_BATCH_MAX_BYTES (THE-500)

100 notes was the prior hardcoded flush size before THE-500 made it configurable
(`args.batch?.maxNotes`); 8 MiB is the accompanying byte cap for batches of large notes
(`args.batch?.maxBytes`).

## index-vault.ts — representation manifest (THE-683)

Before THE-683, `indexVault` hand-built its own copy of the representation manifest instead of
accepting the caller's. That hand-built copy carried a comment warning that if it drifted from
`runtime/indexing-wiring.ts`, "boot and index_vault each DROP and rebuild the table the other just
built — an unbounded rebuild loop." THE-683 changed the function to accept the manifest identity
from the caller instead of recomputing it, which makes that drift unrepresentable rather than
merely tested-against. A caller without one (tests, eval harnesses) builds it with
`buildRepresentationManifest`, the same function boot uses, so there remains exactly one
derivation of the manifest in the codebase.

## index-vault.ts — dedup registry seeding (THE-445)

The dedup registry (`dedupRegistry`, migration `20260719_001`) is one in-memory map shared across
the whole walk, keyed on `content_hash` (the enriched embed text under THE-406, not the raw
`body_sha`) so distinctly titled notes never share a vector.

THE-445 seeds the registry, before the walk starts, from embed texts already embedded in a PRIOR
run — reading existing `chunks` rows and taking the first path (by `path, chunk_index` order) per
`content_hash`. Without this, content indexed under an UNCHANGED path (never re-walked this pass,
so never registered by the walk itself) would fail to dedup against a new path carrying the same
embed text. Seeding is gated on `hasBodySha`, which mirrors when the copy path is active
(`dedupEnabled`).

Caveat: if a seeded first path's content CHANGES in the same run, a same-embed-text new path
defers to a now-stale first path. This self-heals on the next reindex, since the new path then
becomes the first.

## index-vault.ts — two-phase batching (plan then apply)

Two-phase batching: PLAN each note (including its `embed()` network call) with no transaction,
then APPLY a batch of plans in ONE transaction. The write lock is never held across a note's
embed, and a K-note reconcile pays ~ceil(N/BATCH) fsyncs instead of N. A batch is the atomic unit —
a mid-batch failure rolls the whole batch back, which only costs re-work (the reconcile is
idempotent, the content-hash skip re-converges next pass), never correctness.

**THE-925 correction:** this section used to claim the plan/apply gap was safe because `indexVault`
is "the sole writer on this single connection during the reconcile" — that stopped being true once
THE-455 routed `write_note`/the vault watcher through `IndexCoordinator` -> `indexNote` on the SAME
`cache.db` connection, with no serialization against `indexVault`. A concurrent `indexNote` commit
for the same path can land between a plan's pre-read (`preloadChunkState`/`computeNotePlan`) and its
apply here, since both happen on one connection but the plan spans an `await` (`embedPlans`'s
network call) with no lock held across it. Applying a plan whose pre-read `existing` snapshot has
since gone stale would either revert the concurrent commit's fresher content back to what the plan
saw, or prune chunk ids the concurrent commit already rewrote. The fix is a freshness guard,
immediately before each plan is applied inside the batch's write transaction: re-read the path's
current chunk rows (`readExistingChunkRows`) and compare them to the plan's `existing` snapshot
(`existingRowsMatch`, both in `indexing/note-plan.ts`); a mismatch skips that note's writes entirely
rather than applying them, and the next `index_vault` re-plans the path against current content.
`indexNote` itself has the identical plan-then-await-then-apply shape but does not need this guard:
`IndexCoordinator` is its only production caller and already serializes same-path work, so no second
write for the same path can land inside one `indexNote` call's own `await`. Reproduced and pinned by
`test/index-vault-concurrent-write-guard.test.ts`.

The embed() calls are additionally batched across the whole flush batch (THE-277) BEFORE opening
the write transaction, so the reconcile makes ceil(chunks/EMBED_BATCH) requests with a few in
flight instead of one serial round-trip per note. The write lock is still never held across a
network call.

## index-vault.ts — embed-rejection quarantine (THE-390)

A chunk the embedding provider rejects even alone quarantines its NOTE: the rest of the batch
still applies and the reconcile completes (surfaced via `stats.notes_embed_failed` + reconcile
health; the content-hash skip retries the note next pass).

This is a deliberate consequence, not an oversight: a quarantined note keeps serving its
LAST-INDEXED chunks (stale-but-consistent) rather than being pruned to a search hole or failing
the whole reindex. Its notes/FTS metadata may be newer than its chunks, which the notes pass
already allows by design (THE-291 independence — see below).

## index-vault.ts — two-transaction split (notes vs chunks) (THE-291)

The notes/FTS pass is flushed INDEPENDENTLY of the chunk/embed pass, so a broken embedding backend
cannot block metadata/FTS readiness (they need no embeddings). Notes batches commit inline during
the walk; chunk plans still batch through the embed flush.

This two-transaction split is a deliberate atomicity gap. It is safe ONLY because the next
`index_vault` self-heals either side (an absent chunk set re-embeds; a missing notes row is
rewritten). That invariant is pinned by `test/index-selfheal.test.ts` — do not break it.

## index-vault.ts — THE-823 (link extraction needs the note's own path)

`processNote`'s `rel` parameter is already in scope at the point `noteLinks.set(rel, ...)` runs —
this is the whole reason the boot reconcile's "frontmatter is not valid YAML" degrade message used
to name no file, even though this call site knew one. THE-823 fixed the degrade message to use it.

## Excluded files (Obsidian's `userIgnoreFilters` + `index.excludePaths`)

`index-exclusion.ts` loads the vault's exclusion list (a stat-keyed cache of `.obsidian/app.json`, last
good list kept on a parse error, merged with `vaults[].index.excludePaths`). `indexVault` takes it as
`isIndexExcluded`, evaluated per pass from a fresh snapshot, so both transitions fall out of one
mechanism: an excluded walked note stays in `walkedSet` and the link universe but never enters `notes`,
and `sweep-notes.ts` de-indexes whatever an earlier pass left (dismissing open contradiction rows with a
reason instead of deleting them). `desiredEdges` drops every edge touching an excluded note, so the
persisted graph omits them while a wikilink to one still resolves. The m2 search tools add `!excluded`
to the same readable predicate the ACL uses, so a stale row never surfaces. Index-on-write
(`indexing-wiring.ts`) honors the list too, and a debounced watcher event on `.obsidian/app.json`
triggers a reconcile through `exclusion-reload.ts` when the effective list changed. Every production
`indexVault` call site must pass `isIndexExcluded` (`test/index-exclusion-wiring.test.ts` scans for it).

## doctor index.coverage — missing and stale notes

`doctor --probe` compares the notes on disk with the `notes` table. A readable note with no row is
reported as missing. A note that has a row but whose file mtime is more than 2 seconds past the
row's `indexed_at` is reported as stale: the index holds an earlier version, typically because a
write's index step was skipped for broken frontmatter YAML. Both are warnings, never failures, and
both clear on the next `index_vault` once the note's YAML is fixed. The 2 second slack absorbs the
gap between a file's mtime and the `indexed_at` stamped just after it.

## index-vault.ts — graph densification (THE-486, docs/plans/2026-07-13-graph-densification.md)

Densification reconciles derived edges — shared-tag co-occurrence and vec0 kNN neighbors — on
their OWN edge_types, so the literal layer and the LLM layer (`semantically_similar_to`, built
out-of-band by the densify-llm runner) are never touched by this code path.

**Flag-off semantics.** A densification flag OFF still reconciles to an EMPTY desired set via the
FULL `reconcileDerivedEdges` — that is what makes "turn the flag off" actually prune (the layer
must not survive invisibly, ready to reappear the moment the flag flips back on).

**Delta vs cold-start vs full recompute.** A flag ON reconciles DELTA-only once a baseline exists:
only the notes/chunks this pass actually touched (plus, for kNN, their existing edge-neighbors and
forward vector neighbors — see `knnDiscoveryScope`) are re-scored; edges entirely outside that
scope are assumed already correct and are never read or rewritten. The very FIRST on-pass (no rows
of this edge_type exist yet — "cold start," which also covers a flag just flipped from off, since
off always prunes to zero) has no delta baseline to build on and falls back to the full recompute,
exactly matching the old always-full behaviour for that one pass.

Reconciling unconditionally against a `vault_edges` table that predates migration `20260713_001`
would throw on the upsert and kill the entire index pass, hence the `derivedColumnsOk` guard around
all of this.

**Tag-cooccurrence warm delta (THE-486).** The warm-delta branch computes the FULL post-pass tag
map as the old snapshot overlaid with this pass's walked notes' fresh tags, minus anything deleted
— cheaper than re-reading the whole notes table, and exactly what a fresh read would produce anyway
(every untouched note keeps its old value). When NO note's tags changed this pass, the call is
skipped entirely (not even the scope build runs) — the same "no scan on a true no-op" guarantee as
the kNN branch below, applied to the tag layer.

**kNN discovery scope (THE-533).** The kNN branch uses `knnDiscoveryScope`, not a narrower
edge-only "neighbor scope": the edge-only expansion cannot reach a note that would newly rank a
changed/new note in its OWN top-k without being ranked back, so it needs the forward vector
neighbours too. This costs one extra `vecKnn` per CHANGED chunk (not per vault chunk), which is
what keeps THE-486's speedup intact. When `densifyKnnRequested` is true but `changedChunkPaths` is
empty, nothing this pass could have invalidated any `similar_to` edge, so the acceptance criterion
(criterion 1) applies: skip the call entirely, not even a scope lookup, rather than paying any kNN
scan on a warm no-op pass.

## query_cache.ts — module header (THE-497)

The query-product cache caches the expensive-but-reusable products of a retrieval (the query's
dense/sparse/ColBERT encodings, and the whole graph-search result) under a key that binds both
halves of THE-496:

1. **IDENTITY** — the caller's ACL fingerprint (`acl.ts`). Two callers with different effective
   read sets never share an entry, so the cache can never serve caller A's content to caller B. An
   incorrect key here is a data leak of the same class as THE-453/THE-456, which is why it is part
   of EVERY key in this file, even for products that do not depend on vault content: it costs only
   cross-principal hit rate (nothing at all in a single-principal runtime) and it also closes the
   timing side channel where B learns that A asked the same question.
2. **STALENESS** — the vault generation (`generation.ts`). The bump lives inside each index write
   transaction, and the design deliberately errs toward bumping: a missed bump would silently serve
   stale results, while an over-bump is merely a cache miss. This cache inherits that asymmetry
   rather than re-deriving it.

Two design decisions worth keeping in mind when touching this file:

- **The key is structural, not enumerated.** `GraphSearchOptions` carries ~30 knobs and grows most
  months. A hand-listed key would silently stop covering the next one added, and the failure mode
  is serving a result computed under a DIFFERENT configuration — invisible, and wrong. So the key
  hashes the whole options object generically (`hashInto`); a new option participates the day it is
  added, with no edit here. `query-cache-key-coverage.test.ts` is the gate that proves it.
- **The key does not contain the query vectors.** It contains the query TEXT plus a
  REPRESENTATION descriptor (what a vector means: provider/model/dimensions + which streams are
  on). Keying on the vectors would be circular — computing them is the expensive part being
  skipped, so a cache that needs them first can only save the DB work, never the model round-trip.
  Vectors are a pure function of (text, representation), so this is exact, not an approximation.

## query_cache.ts — measured on a real vault; why `retrieval.cache.enabled` stays off

`eval/query-cache.ts` drives `vault_graph_search` (and `search_and_read`, `vault_context`) through real
dispatch, cache ON versus OFF, on a copy of a real 15,933-chunk bge-m3 index; the pre-registration was
written before any run, and the full artifacts live outside the repo (they hold private query text).
Query vectors were precomputed (embedding cost ~0 in both arms) unless stated. Medians over 5 reps with the
arms alternating order; the box was shared (load average roughly 1 to 12), so read ratios, not absolutes.

| stream | subset | OFF p50 / p95 (ms) | ON p50 / p95 (ms) | hit rate |
| --- | --- | --- | --- | ---: |
| 10% repeats (278 calls) | repeat calls | 842 / 1578 | 3.7 / 6.7 | 10.1% |
| 30% repeats (358 calls) | repeat calls | 887 / 1825 | 0.7 / 1.8 | 30.2% |
| 30% repeats, live bge-m3 (86 calls) | repeat calls | 867 / 1157 | 1.1 / 2.2 | 30.2% |
| 0% repeats (250 calls) | first sightings | 870 / 1433 | 891 / 1484 | 0% |

Every ON repeat-call p95 sits below every OFF repeat-call p95 in every rep. The first-sighting difference
(+20 ms at p50) is inside the OFF arm's own rep-to-rep spread (389 ms) and under the registered allowance
(5%). A hit also skips the embedding call (358 to 250 per stream); one real embedding round trip measured
150 ms p50.

**Identity.** `results` was byte-identical to the cache-off response on every call (three streams, a live
arm, two callers' ACLs on one shared cache, and across a generation bump). Cross-caller hits: 0, with a
non-vacuous arm (238 of 240 queries answered differently to the restricted caller, 240 hits on the replay).
The bump made every entry a miss (100 of 100) and the post-bump responses matched the cache-off ones. The
whole response is NOT byte-identical for `vault_graph_search`: a hit never runs the pipeline, so the
`coverage` estimate its `onCoverage` sink would fill is absent. Every ON hit differs from OFF by exactly that
one key and by nothing else (140/140, 540/540, 78/78, 240/240, 100/100 hits); `search_and_read` and
`vault_context` responses carry no `coverage` and had 0 differences. `knowledge_search` has the same sink and
the same expected gap but only serves a docs-kind vault, so it was not driven. Closing the gap needs a
decision, not a one-liner: `COVERAGE_ONLY_FIELDS` are stripped from the key on purpose, so replaying a stored
estimate would serve one computed under a different calibration.

**Memory.** At the shipped `maxEntries` of 64 per cache, 64 results entries at `final_top_k` 100 are 11.7 MiB
(entries 129 KiB median, 337 KiB max; p95/median 1.5 to 1.7) plus 0.8 MiB of query encodings, 12.5 MiB in all,
and the heap held was 8.9 MiB. The chunker bounds a chunk (max 2,099 characters here), so `maxEntries` is a sound
bound and no byte bound was added. It would matter if `final_top_k`'s ceiling or the chunk size grew.

**Real traffic.** The live store's event and retrieval history holds 251 `vault_graph_search` calls, all in
one golden-set replay with one repeated argument hash (0.4%), and about five organic calls in two months. That
cannot establish a repeat rate; it shows none.

**Decision.** Off, for two measured reasons: the whole-response identity gap above, and no observed repeat
traffic. The latency win on a repeated query is large and the memory bound holds, so an operator whose
clients repeat queries can enable it today (`results` is unaffected).

**Re-measured 2026-10-02 without the contaminating note.** The index copy above carried a note that quoted the
golden queries verbatim, so every call's lexical stream returned that one note as a distractor. The same harness, seed
and stream shapes were re-run on a copy with that note dropped (15,918 chunks against 15,933), one arm at a time:
repeat calls 416 / 999 ms p50 / p95 OFF against 0.8 / 1.0 ON at a 10% repeat rate (28 repeat calls, 3 reps rather than
5), first sightings 460 OFF against 438 ON (inside the OFF arm's own rep-to-rep range of 55 ms), hit rate 10.1%, memory
11.7 MiB of results plus 0.8 MiB of encodings for 64 entries at `final_top_k` 100 (median entry 127 KiB, max 337 KiB; heap held 8.8 MiB). Identity is
unchanged: `results` identical on every call, every cache-ON hit differs from OFF by the one `coverage` key (84 of
84 here), the two-caller arm has 0 cross-caller hits with 236 of 240 queries answered differently to the restricted
caller (238 before), and the generation bump makes 100 of 100 entries misses. Absolute latencies are about half
the earlier ones; the box was less loaded and the load average is not controlled, so read the ratios, which are
what the decision uses. The decision is unchanged, and so is each of its bars. The r=30% stream, the live-embedding
arm and the other two tools were not re-run.

## query_cache.ts — FUNCTION_FIELDS: `activationFor` (THE-424 Part A / Part B)

`activationFor` is a DB lookup of `cached_activation_score`. It was re-reviewed for THE-424 Part A,
which wired `bubbleSafe` into the serve path: the entry used to lead with "inert unless
bubbleSafe.enabled," and that clause is now false whenever an operator sets
`experiential.activationRerank`.

What the sentinel drops is the lookup's IDENTITY, not the values it returns — one process holds
exactly one `activationFor`, built once from config (`runtime/stores.ts`). What varies is the
VALUES it returns, since `recomputeActivation` rewrites `cached_activation_score` without bumping
the generation. So a cache hit inside the TTL can serve an order computed from pre-recompute
activation. That is bounded twice over: the bubble pass moves any item at most one position, and
the TTL bounds how stale the scores can be.

**Correction after THE-424 Part B.** This comment used to end "never a wrong result set,"
reasoning that a one-position bound cannot change top-K MEMBERSHIP. It can: an item at rank K+1
moving to rank K is a one-position move that swaps a document into the returned set. Measured on
the public evergreen corpus: zero membership changes at the 512-token chunk budget, but 1-2 queries
of 78 at 256, because denser chunks crowd the rank-K boundary. The POSITION bound held in both; the
set-invariance was a property of that corpus at that budget, never of the mechanism. The honest
bound is: at most one adjacent swap, which at fine chunk budgets may mean one document entering or
leaving the top-K.

This is accepted deliberately: keying on activation values would invalidate the whole cache on
every recompute, which costs more than the one-slot drift it would fix. If the bubble pass ever
becomes a full re-sort, this trade dies and activation must enter the key.

## query_cache.ts — TRACE_SELECTOR_FIELDS: `traceNotePath` (THE-632, cross-vendor review correction)

`traceNotePath` selects which note the trace FOLLOWS (`diagnose_retrieval`'s per-note trace sink,
THE-632). It never filters, boosts, or reorders — results are byte-identical with it set, unset, or
pointed at a different note.

**Correction (cross-vendor review).** An earlier version of this comment said the field was
"deliberately UNKEYED." It is not: `graphSearchKey` deletes only `DERIVED_VECTOR_FIELDS` and
normalizes `reranker`; `FUNCTION_FIELDS` drop out because JSON serialization discards functions,
but `traceNotePath` is a STRING and therefore lands in the key. The `TRACE_SELECTOR_FIELDS` list is
a declaration of intent that the coverage gate reads, not a filter the key itself applies.

That mismatch is inert rather than wrong: `cachedGraphSearch` bypasses the cache outright whenever
tracing is set, so the fragmenting entries the original comment worried about are never written.
Anyone making tracing cacheable must strip this field in `graphSearchKey` as well as listing it
here — listing it here alone does nothing.

The cache-HIT caveat bites harder here than for the observability-only sinks: a hit returns the
cached results WITHOUT running the pipeline, so no trace records are produced and the caller sees
an empty trace for a search that "worked." That is why `diagnose_retrieval` calls `graphSearch`
DIRECTLY and never `cachedGraphSearch`. Anyone wiring tracing into the cached path must handle that
explicitly — a silently empty trace reads as "the note was never anywhere," which is a wrong
answer, not a missing one.

## query_cache.ts — COVERAGE_ONLY_FIELDS (THE-631 item 2, THE-733)

`staleThresholdDays` sets the age past which a returned note counts toward
`CoverageEstimate.staleReturned`. It reaches exactly one place — `countStaleNotes`, whose output is
handed to `estimateCoverage` and reported through `onCoverage`. It never touches seeds, expansion,
fusion, diversity, rerank, or projection, so two calls differing only in it return BYTE-IDENTICAL
results and must share a cache entry.

Unlike `TRACE_SELECTOR_FIELDS`, this does NOT bypass the cache, so it is stripped in
`graphSearchKey` rather than merely listed in `COVERAGE_ONLY_FIELDS` — keeping it in the key would
fragment the cache by a knob that cannot change what is cached.

The cache-HIT caveat is the mildest of the observability-only fields: a hit never calls
`graphSearch`, so `onCoverage` does not fire and the tool layer omits `coverage` entirely (the
schema field is optional for exactly this). A stale threshold therefore cannot produce a WRONG
staleness count from cache — only an absent one, which is already the documented behaviour for
every coverage field.

THE-733 added `scoreCalibration` and `engineVersion` to this list on the same grounds. Both reach
exactly one place — `confidenceFor`, whose output is the `confidence` field of the coverage
estimate — and nothing downstream of it touches scoring, fusion, or ordering. Two searches
differing only in which calibration row was current return byte-identical RESULTS and must share a
cache entry; keying on them would fragment the cache every time a vault is recalibrated, for no
change in what is cached.

## query_cache.ts — `copyResults` deep-copies `via_edge` (THE-626)

`GraphSearchResult` is NOT flat — `via_edge` (`graph_search_stages/types.ts`) is itself an object,
so a bare `{...r}` spread only protects the top-level fields; `via_edge` would still be the SAME
object shared between the cached entry and every caller that ever read it, so one caller mutating
it would corrupt the entry for every later reader. `copyResults` deep-copies that one field
explicitly rather than reaching for a generic deep clone: it is the only nested field this type has
today, and this runs on every hit AND every store, so a speculative general-purpose clone is not
worth paying for on fields that are already flat.

`query-cache.test.ts` has a mutation test exercising this.

## query_cache.ts — QueryCache.set() expiry sweep (THE-626)

`set()` sweeps one expired entry before growing the map. Without this, an entry that expires and is
never re-requested just sits at the front of the LRU order — `get()` is the only other place that
checks `expiresAt`, and only for the key actually asked for — until ordinary capacity pressure
evicts it. That eviction lands on the right entry often enough to hide the bug, but it is charged
as an LRU eviction rather than an expiration, and in the meantime the dead entry occupies a slot a
live one could have used instead.

Map iterates in insertion order and `get()` only reorders on a HIT, so the front is the
least-recently-touched entry — a good proxy for "expired," though not a proof: an entry can be
touched (moved to the back) without its `expiresAt` moving with it, so this does not catch every
dead entry. A single check is O(1) amortised; scanning the whole map on every store was judged not
worth the extra correctness for a cache this size.
