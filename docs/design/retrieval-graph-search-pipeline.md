# Retrieval: graph search pipeline

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Staged pipeline (THE-465)

`graph_search.ts` used to be a monolith. THE-465 split it into the staged modules under
`graph_search_stages/`, with `graphSearch`/`graphSearchCore` as a thin orchestrator that threads
each stage's typed output into the next. The public API (`graphSearch(db, opts)` signature,
`GraphSearchResult` shape, every `GraphSearchOptions` default) is unchanged by the split — types
are re-exported from `graph_search_stages/types` so every existing import path keeps working.

Actual run order, verified against the `runStage(...)` call sequence in `graphSearchCore` (not the
historical monolith's order): `seedGeneration -> classify -> graphExpansion -> candidateAssembly ->
scoreFusion -> diversity -> gatedRerank -> projection`.

`classify` is a post-seed router: it consumes seed *strength* (`seedZMargin`, computed from the
seeds `seedGeneration` already produced) and never sees the query text, so it structurally cannot
run before `seedGeneration`. There is also an early return between the two stages
(`if (seeds.length === 0 && lexHits.length === 0 && sparseHits.length === 0 && ... ) return []`)
that can terminate the whole pipeline before `classify` is ever reached.

Default fusion mode is `graph_rrf` (the eval winner: RRF over the seed + expansion streams *is*
the final ranking — no reranker call, so a rank-1 seed cannot be displaced by an inflated
expansion score). `rrf_rerank` / `score_merge` route through the injected reranker (D1 gateway
passthrough at integration; graceful no-op fallback otherwise).

## Coverage taxonomy (THE-631, THE-628)

`ALL_SOURCES` is the denominator for `CoverageEstimate.armsPossible` and the enumeration
`estimateCoverage()` checks presence against.

THE-628 (first PR) deliberately does **not** add `"summary"` to this taxonomy. `GraphSearchResult.source`
and `Candidate.source` both accept it (`types.ts`) so a summary candidate can flow through fusion
and projection, but folding it into the coverage taxonomy would move `armsPossible` from 5 to 6 for
*every* search, on every config — including the default, flag-off one, where a summary candidate
can never appear. That's a visible behavior change outside that PR's scope (dark mechanism only, no
retrieval-quality claim). Extending the taxonomy — and the matching `schemas.ts` `z.enum` for
`CoverageEstimate.arms` — is a follow-up once the summary stream is actually enabled somewhere.

THE-628 (second PR) extends this same deliberate omission to `"cluster_summary"` — same rationale,
same follow-up.

## `traceStage`: exception isolation (THE-632)

`traceStage` is a pure side-channel on the same contract as `onCoverage`: it reads the
intermediate arrays already held by `graphSearchCore`/`graphSearch` and reports; it never filters,
reorders, or feeds anything back, so results are byte-identical with tracing on or off.

Cross-vendor review caught that an earlier version's unguarded `emit()` call made the "pure
side-channel" claim false in one direction: a throwing callback turned a successful search into an
error. A diagnostic that can break the thing it observes is not a side-channel. The fix wraps the
`emit()` call in try/catch (mirroring how `deps.observability.meter` is guarded on the dispatch
path elsewhere in the codebase).

## THE-632: tracing before the early return

An earlier arrangement had `graphSearchCore` return early (no seeds, no lexical hits, no sparse
hits) while `graphSearch` still unconditionally traced the `projection` stage on the (empty)
result. Cross-vendor review found this misdiagnosed the no-seed case: `summarize()` saw a single
projection record and reported "never entered the candidate pool at projection" — an absurd stage
name for a query that never got past seed generation. The fix traces `seedGeneration` *before* the
early-return check, so the no-seed case produces a real, correctly-labeled trace record instead of
a fabricated one.

## rrfK: k=10 vs k=60 (THE-397)

The `graph_rrf` fusion constant was changed from the folklore default k=60 to k=10, config-exposed
as `retrieval.rrfK`. Full measurement (nDCG@10, recall@10, MRR, replication) is recorded in
`CHANGELOG.md` under `[1.5.0]` / THE-397 — not duplicated here. Summary: with ~30-item stream
pools, k=60 mathematically lets a document ranked near the bottom of two streams outrank a rank-1
single-stream hit; k=10 Pareto-dominates k=60 on the n=32 golden set, while k=20 ≈ k=60 — the
effect only appears below the pool-size crossover.
