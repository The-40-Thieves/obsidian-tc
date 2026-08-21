# Metrics Registry

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## registry.ts — module overview (G2.4 §Prometheus, THE-211 / THE-183)

The catalog is the exact 8 counters, 2 histograms, and 4 gauges from the observability spec,
registered on a private `prom-client` `Registry` (never the global default, so multiple
recorders — e.g. in tests — never collide).

The recorder is always live: counters are cheap in-memory adds and back both `get_metrics` and
the optional `/metrics` scrape endpoint, which stays disabled by default (G2.4 `:0`).

Coverage note (honest, per spec): every catalog name is registered so `/metrics` is
catalog-complete, but two counters have no V1 emission source — `idempotency_hits_total` and
`idempotency_cache_skipped_total` (idempotency replay is forward-compat, THE-197) — and the
`idempotency_cache_bytes` gauge likewise. They expose as registered-zero until that subsystem
lands; this is documented rather than faked.

## GaugeSources — query-cache gauges (THE-507, folding in THE-497's cache)

`queryCacheHits` / `queryCacheMisses` / `queryCacheEvictions` / `queryCacheExpirations` measure
THE-497's retrieval query cache. The `vault` label carries the CACHE name ("results" / "vectors")
rather than a vault id — the cache is process-wide and keyed internally by vault, so it has no
per-vault counts to report.

These are cumulative counts exposed through the gauge seam rather than as Counters because the
cache owns the numbers and the recorder only reads them; a Counter would need the cache to call
INTO the recorder, which would invert the dependency the composition root exists to keep one-way.

Hit rate is `hits/(hits+misses)`; a rising eviction count against a flat hit count means
`retrieval.cache.maxEntries` is too small, and expirations rising instead means the TTL is what is
bounding reuse.

## SQL_LOCK_WAIT_BUCKETS (THE-585 #5)

Buckets straddle the configured `busy_timeout` (5s) with a second boundary above it (10s): a
timed-out acquisition always measures slightly OVER the timeout — 5000 ms of `busy_timeout` was
measured at 5006 ms, because the sample spans SQLite's busy-handler loop plus the call overhead
around it. With 5 as the top bucket every timeout would fall into `+Inf` alone, and "waited the
full timeout and then threw" would be indistinguishable from "waited a minute". The 5..10s band is
where timeouts land.

## vecRebuild counter — obsidian_tc_vec_rebuild_total (THE-612)

`ensureVecChunks` DROPs and rebuilds `vec_chunks` — a full re-embed of every vault sharing the
table — whenever the stored representation fingerprint drifts or a legacy pre-partition shape is
detected. This is rare (a deploy changed the embedding model, or a one-time schema upgrade) and
huge blast radius (dense retrieval goes cold for every vault until re-embedded), and previously
had no counter at all. No `vault` label, because the event is not scoped to one vault — see
`obsidian_tc_auth_rejections_total` for the same precedent.

## outputSchemaDrift counter — obsidian_tc_output_schema_drift_total (THE-417 Phase 2)

This is the instrument that makes warn-mode runnable. Before it existed, a schema mismatch wrote
one stderr line among every other internal error and nothing accumulated it, so "let warn-mode
surface latent mismatches" had no way to be read. Labels are bounded exactly like
`obsidian_tc_tool_calls_total`'s — vault id and tool name, never the payload or the Zod issues,
which would put note content into a label.

## activationRecomputeChunks counter — obsidian_tc_activation_recompute_chunks_total (THE-645 item 1)

`registerActivationRecompute`'s `onRecompute` stats were computed every tick and discarded —
nothing outside the process could see whether the periodic ACT-R activation recompute was running,
or how much work it was doing. `vault` carries the bounded job name ("activation-recompute"), the
same process-wide-subsystem precedent the scheduler gauges use, since the recompute runs once over
the whole experiential store rather than per vault.

## sqlLockWait / retrievalStageDuration histograms (THE-585 #5 / #6)

`sqlLockWait` is the signal THE-467/468 cannot be argued without — how long writers block each
other on ONE shared cache.db. Under WAL readers never block, so every sample here is
writer-vs-writer contention and nothing else. It observes EVERY acquisition, including the
uncontended ones that fall in the 1 ms bucket: without those the histogram would have no
denominator and a claim like "5% of index writes waited >100 ms" could not be computed at all. The
`txn` label is the closed `WriteTxnLabel` union, so an operator can tell a reindex waiting on a
live tool call from the reverse.

`retrievalStageDuration` / `retrievalStageCandidatesIn` / `retrievalStageCandidatesOut` are THE-585
(#6). `stage` is the closed `StageName` union from THE-465's instrumentation, so the label set is
bounded at 8 by construction — no cardinality work was needed. The two candidate counters are the
point, more than the duration: their RATIO per stage is the retrieval funnel.
`candidates_out / candidates_in` says which stage is actually filtering, and a stage whose ratio
drifts to 1.0 has quietly stopped doing its job while still costing its latency. Neither number
answers that alone.

## aclWalkPruned counter — obsidian_tc_acl_walk_pruned_total (THE-891 item 3)

The graph-walk ACL filter (THE-695/THE-852) has been unconditional since v1.22.0 — fine for
correctness, but its recall cost (readable notes reachable only through an unreadable bridge) had
no signal at all until this counter. It is only ever non-zero for a RESTRICTED caller:
`resolveAclWalkFilter`'s structural-no-op argument for an unrestricted one (`retrieval-runtime.ts`)
means this stays at zero for the common single-principal deployment, which doubles as a live check
of that argument rather than just a doc claim.
