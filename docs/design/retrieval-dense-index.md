# Retrieval: dense (vec0) index and brute-force fallback

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Extension loading and the embedded fallback (THE-663)

SQLite's extension loader derives the entry-point symbol it `dlsym()`s from the loaded file's
*basename* (stripped of extension, prefixed `sqlite3_`, suffixed `_init`) rather than from any
metadata in the binary. `materializeEmbeddedVec` therefore has to name the materialized file
exactly `vec0.<ext>` — anything else fails with an "undefined symbol" error even though the bytes
are byte-for-byte correct.

The embedded fallback exists because `require("sqlite-vec")` resolves relative to
`import.meta.url`, which `bun build --compile` freezes to the *build machine's* path. That means
the plain `require` throws in every published standalone binary, on every platform — not only the
cross-compiled ones, which is what made this surprising when first diagnosed. `loadVec` falls back
to the copy baked into the binary for its own target platform (`vec-embedded.ts`).

## Representation manifest and fingerprinting (THE-460, THE-683)

`ensureVecChunks` takes the full `RepresentationManifest`, not the narrower `VecFingerprint`. The
manifest is a structural superset, so nothing is lost — but the extra axes (pooling, instruct
prefixes, MRL truncation, multi-vector heads) are exactly the ones that can make two "same
provider, same model" representations produce non-interchangeable vectors. Taking the fingerprint
alone is what previously let `embeddings.pooling` be a validated, documented config key that
silently changed nothing (it wasn't folded into the old fingerprint shape, so a pooling change
never triggered a rebuild).

A fingerprint mismatch is the general rebuild trigger. It subsumes the old THE-457 dims-only check
(dimensions are one field folded into the fingerprint) and additionally catches a same-dimension
model swap, a chunker/enrichment version bump, or a schema-gen bump.

### THE-460 fix A: filtering the backfill by model, not just byte length

The pre-partition rebuild backfill originally filtered candidate vectors by byte length only
(`length(embedding) = dims*4`). That can't distinguish a same-dimension model swap — old-model
vectors are exactly `dims*4` too — so they passed the guard and refilled the index while the
stored fingerprint claimed the new model. Retrieval then silently scored new-model queries against
old-model embeddings: not an error, just quietly wrong results.

The fix adds an `e.model = ?` predicate. `chunk_embeddings.model` stores `provider.id` (e.g.
`"ollama:bge-m3"`), not the bare `fp.model` — binding `fp.model` there could never match a
production row, so an earlier version of this fix silently selected zero backfill rows after *any*
fingerprint-triggered rebuild whose `provider.id` didn't also change. Revision (`withRevision`) was
the first operator-settable field that moves the fingerprint while leaving `provider.id` untouched,
which is what surfaced the bug. `opts.activeModel` now carries the actually-stored identity, and
falls back to `fp.model` only when absent (non-production callers, back-compat).

## `.changes` is not a row count on vec0 (THE-612)

The post-backfill row count in `ensureVecChunks` is deliberately a plain `SELECT COUNT(*)`, not
`.changes` from the preceding `INSERT`. vec0 virtual tables are backed by several shadow tables, so
`.changes` reports shadow-table writes rather than logical rows — measured at 6 for a single
logical row backfilled. Since `vec_chunks` was just `DROP`ped and recreated, a plain `COUNT(*)`
after the insert is exactly what that insert wrote: cheap and exact, unlike `.changes` here.

## Exact-tie ordering and the aarch64/x86_64 divergence (THE-582)

`totalOrderByDistance` imposes a total order (distance ascending, then `chunk_id` compared by code
unit) on vec0 KNN results, because vec0 rejects a second `ORDER BY` key
(`"Only a single 'ORDER BY distance' clause is allowed on vec0 KNN queries"`), so `ORDER BY
distance, chunk_id` isn't available in SQL.

Exact ties are not a corner case: any two chunks with identical content embed to identical vectors
and therefore to a bit-identical distance (duplicate bodies, repeated boilerplate, shared
templates). In the perf corpus (`dupGroups=20` over 100 notes) the rank-10 distance spanned the
top-10 cut on 3 of 5 labelled queries — the tie order decided top-10 *membership*. That's how the
same commit produced `retrieval.ndcg_at10` **0.8028 on aarch64** vs **0.8414 on x86_64**, while
`recall_at10` (set-based) and the candidate counts matched exactly across both hosts — the ranking
metric was host-dependent even though the retrieved *set* was not.

`chunk_id` is compared by code unit, not `localeCompare`, deliberately: locale-sensitive collation
would trade one source of host dependence for another. The brute-force fallback in `semantic.ts`
breaks ties on the same key (score descending, then `chunk_id` by code unit) so the two backends
can't diverge on tie-break order.

## Brute-force fallback: batched cosine (THE-420, THE-504)

The brute-force scan scores the whole candidate set in one native crossing (`cosineBatch`) instead
of one native call per row. Per-pair cosine across the JS/native boundary is dominated by
re-marshaling the f64 query on every call — measured **13–22x slower** than plain JS per-pair
scoring. `cosineBatch` marshals the query once (as a `Float32Array`, converted once per search) and
scans the corpus in native code.

## Crowding-out and the ACL side channel (THE-287, THE-277, THE-585)

A global vec0 KNN's top-N can be dominated by chunks the caller cannot see, silently returning
fewer than `k` visible hits even though visible candidates exist further down the ranked list
(THE-287). THE-277 made cross-vault crowding structurally impossible by adding `vault_id` as a
vec0 partition key, so the KNN never scans another vault's vectors. Within a vault, crowding is
still possible, so `semanticSearch` over-fetches (`k * 20 + 50`) and falls back to the exhaustive
brute-force scan whenever the over-fetched candidates can't fill `k` visible hits *and* the index
holds at least as many chunks as the over-fetch cap (otherwise every chunk has already been seen,
which is an exhaustive read, not a degradation).

`onFallback` reports *why* the brute-force path was taken (`"error"` — vec0 threw, usually a
dimension mismatch after an embedding-model change; `"underfill"` — the ACL-crowding case above).
It's a callback rather than a metrics handle, matching `graphSearch`'s `onStage` and
`indexVault`'s `onNotesPass`: this module must not learn about the metrics recorder, so the
composition root wires it and the dependency stays one-way. Best-effort by contract — a throwing
callback must never turn a correct (if slower) result into an error.
