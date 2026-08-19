// Single source of truth for which migration file belongs to which chain. The completeness test
// (audit #9) asserts every migrations/*.sql appears in exactly one of these arrays, so a new SQL
// file that is not wired into a chain fails CI instead of silently never running. Order is
// application order — append, never reorder.

/** cache.db chain (db/provision.ts). */
export const CACHE_MIGRATION_FILES = [
  "20260519_001_initial.sql",
  "20260519_002_entity_unique.sql",
  "20260626_001_vault_edges.sql",
  "20260626_002_plane.sql",
  "20260702_001_notes.sql",
  "20260703_001_vault_edges_vault_id.sql",
  "20260709_001_snapshots.sql",
  "20260713_001_vault_edges_derived.sql",
  "20260719_001_chunks_body_sha.sql",
  "20260722_001_chunks_dedup_index.sql",
  "20260723_001_vault_generation.sql",
  "20260723_002_jobs.sql",
  "20260724_001_plane_vault_id.sql",
  "20260724_002_idempotency_state.sql",
  // THE-627: client_name / client_version on workspace_sessions, read from MCP `_meta`.
  "20260727_001_session_client_info.sql",
  "20260728_001_jobs_owner.sql",
  "20260728_002_jobs_outcome.sql",
  // THE-694/695: the read-ACL predicate, joinable from SQL.
  "20260802_001_acl_path_sets.sql",
  // THE-726: `principal` on workspace_sessions — the server-OBSERVED owner, kept distinct from the
  // caller-supplied `caller` column so an active session can be resolved durably rather than from a
  // process-local map. Belongs in the CACHE chain because workspace_sessions is created by
  // 20260519_001_initial.sql, in cache.db. The migration header carries the full reasoning.
  "20260804_001_workspace_sessions_principal.sql",
  // THE-737: session traces move out of the vault to cacheDir. `trace_store` records which
  // store a row's `trace_path` is relative to, so the legacy (vault) and new (cache)
  // generations resolve differently without sniffing the path string.
  "20260805_003_session_trace_store.sql",
  // THE-833: memory_entities.status ('active' | 'retired'). Belongs in the CACHE chain because
  // memory_entities is created by 20260519_001_initial.sql, in cache.db (the memory-entity graph
  // is authored/materialized state, not the experiential tier's observed/derived one). The
  // primary path of the memory-entity lifecycle — get_entity / query_entity_graph filter retired
  // nodes by default, and rename_entity's shape is how a caller flips it (see that tool's
  // handler for why retiring is folded into rename rather than a fifth tool).
  "20260814_001_memory_entity_status.sql",
  // THE-647 item 1: 20260818_001 adds the per-(caller, vault) watermark backing differential
  // vault_context. Belongs in the CACHE chain because vault_context reads chunks/syntheses/
  // contradictions exclusively off ctx.db (cache.db) — the optional include_work episodes leg is
  // the only part of that tool touching experiential.db, and it is unaffected by this table.
  // Borrows THE-461's activation_state discipline (capture the new watermark BEFORE the diff
  // read, persist it only AFTER the response is composed, never regress) rather than re-deriving
  // it — see the migration header and context-watermark.ts for the full reasoning. Not
  // `workspace_sessions`: THE-714 found it stays empty in production.
  "20260818_001_vault_context_watermark.sql",
  // THE-628 (first PR): note_summaries — the note-level (leaf) summary tier, dark behind
  // retrieval.summaries.enabled. Belongs in the CACHE chain (not EXPERIENTIAL) for locality with
  // chunk_embeddings/candidate assembly: a summary is AUTHORED index state derived from the
  // vault's own content (like chunks/chunk_embeddings/notes), not observed/derived retrieval
  // telemetry the EXPERIENTIAL admission test (THE-713, see this file's own comment above) governs.
  "20260819_001_note_summaries.sql",
  // THE-628 (second PR): cluster_summaries + cluster_summary_members — the cluster-level (tier-2)
  // summary layer over tier-1's note_summaries embeddings. Same CACHE-chain locality rationale as
  // 20260819_001 (derived index state alongside chunk_embeddings/candidate assembly, not
  // EXPERIENTIAL's observed/derived retrieval telemetry). Dark behind the SAME
  // retrieval.summaries.enabled flag as tier-1.
  "20260819_002_cluster_summaries.sql",
  // THE-855: capture_queue.poison_risk/poison_signals/trust — assessPoison wired into
  // enqueueCapture (THE-238's scanner, previously only reachable from write_note/append_note per
  // THE-639). capture_queue is created in 20260519_001 above, so this stays in the CACHE chain.
  "20260819_003_capture_queue_poison_scan.sql",
] as const;

/**
 * experiential.db chain (cli.ts).
 *
 * ── THE-713: THE ADMISSION TEST, stated canonically HERE ──────────────────────────────────────
 *
 * Four shipped migration headers describe this store's charter and appear to contradict each other:
 * `20260626_001_experiential_init` says it holds *"only NON-RECONSTRUCTABLE keep-state"*, while
 * `20260725_002_note_quality` and `20260729_001_gap_reports` each admit a table because it is
 * *"DERIVED, RESETTABLE"*. Both phrases are in force and a `note_quality` rollup is plainly
 * reconstructable, so read literally the two rules exclude each other.
 *
 * They are not two rules. They are one rule and one consequence, and the resolution is that
 * **NEITHER phrase is the admission test**:
 *
 *   THE TEST IS TRUST, NOT RECONSTRUCTABILITY. A table belongs here when its contents are
 *   OBSERVED or DERIVED rather than AUTHORED — anything an injected episode, a retrieval event or
 *   a computed rollup can influence. The mechanism is a FILE boundary: nothing here can hold a
 *   foreign key into an authored atom (ids are referenced BY VALUE — "this is the membrane"), so
 *   poisoning blast radius is capped at the store boundary.
 *
 * Given that test, both phrases follow rather than compete:
 *
 *   "resettable"           — a consequence. Because nothing authored depends on this file, losing
 *                            it is survivable and a reset is a truncate, not a filtered delete.
 *   "non-reconstructable"  — a WARNING, not a criterion. Some of what lives here (activation
 *                            history, retrieval feedback, stated goals) cannot be recomputed from
 *                            the vault, so "resettable" must not be read as "costless to discard".
 *
 * `20260803_002_goals` already reasoned this way in practice — it admitted goals by arguing the
 * membrane is a file boundary and the trust boundary is enforced on the WRITE PATH, not by the
 * store's label. This comment states the general rule that case applied.
 *
 * Stated here rather than fixed in place because migration headers are CHECKSUM-PINNED: editing a
 * shipped migration is a hard startup error, so those four sentences cannot be corrected and this
 * is the nearest editable home that every reader of the chain already passes through.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE-222: 20260712_001 is the versioned preference profile (typed-delta updates only) for the
 * reflect pass. THE-44: 20260712_002 is derive-don't-mutate access instrumentation
 * (chunk_access_stats view). THE-239: 20260712_003 is the hash-chained forget audit log
 * (dependency-aware deletion). THE-461: 20260723_001 is the one-row watermark for the incremental
 * ACT-R activation recompute. THE-568: 20260724_001 adds the `caller` column to chunk_retrievals
 * so record_retrieval_feedback can gate on per-caller ownership (P1.7 follow-up). THE-538:
 * 20260725_001 adds the retrieval_policy table plus chunk_retrievals.event_group/stream_source, so
 * a retrieval outcome can be attributed to the fusion configuration that produced it. THE-537:
 * 20260725_002 is the note_quality rollup — a derived, resettable read surface over signals that
 * already exist in both stores. THE-644: 20260729_001 is the gap_reports append-only pass log —
 * persists the gap detector's GapReport so it can be read back instead of recomputed.
 */
export const EXPERIENTIAL_MIGRATION_FILES = [
  "20260626_001_experiential_init.sql",
  "20260711_001_experiential_outcome.sql",
  "20260711_002_agent_episodes.sql",
  "20260712_001_preference_profile.sql",
  "20260712_002_access_views.sql",
  "20260712_003_forget_log.sql",
  "20260723_001_activation_watermark.sql",
  "20260724_001_chunk_retrievals_caller.sql",
  "20260725_001_retrieval_policy.sql",
  "20260725_002_note_quality.sql",
  // THE-644 item 1: 20260729_001 is the gap_reports append-only pass log (persists the gap
  // detector's GapReport so the THE-611 read-only MCP tool has something to read).
  "20260729_001_gap_reports.sql",
  // 20260731_001 is the citation provenance axis: cited_in_response's `1` conflates "the judge
  // confirmed it" with "it passed the cheap stage-1 filter and no judge existed". Additive and
  // observational -- cited_in_response's semantics are unchanged.
  "20260731_001_citation_state.sql",
  // THE-710: 20260803_001 namespaces the preference plane by vault. Note this REVERSES the
  // P1.8-audited global scope on the vault axis only — the caller axis stays an accepted residual.
  // Purge rather than backfill, per the 20260724_001 precedent; the migration header carries the
  // full reasoning and the correction to the ticket's premise.
  "20260803_001_preference_vault_id.sql",
  // THE-633: 20260803_002 is the goals table — STATED intent, distinct from preferences
  // (goals resolve into a terminal state; preferences move by weight and never resolve).
  // vault_id from this first migration, deliberately, because the neighbouring precedent did
  // not have it and needed 20260803_001 to add it.
  "20260803_002_goals.sql",
  // THE-717 item 2: 20260805_001 is the citation-pass run log. A NULL citation_state conflates
  // "never covered", "covered but the kill switch aborted" and "covered but the pass died"; this
  // table separates them. NO vault_id on purpose — chunk_retrievals has no vault column, so a
  // pass genuinely does not know which vault it stamped, and the migration header says why that
  // departs from the 20260803_002 precedent directly above.
  "20260805_001_citation_runs.sql",
  // THE-733: 20260805_002 persists the per-vault calibrated score distribution. `gaps
  // --calibrate` printed it and returned, so no percentile existed at query time and the only
  // number reachable from the request path was a global constant from an n=136 calibration on
  // ONE vault. Carries provenance (engine_version, config_fingerprint) because a distribution
  // is only valid for the engine that produced it.
  "20260805_002_score_calibration.sql",
  // THE-718 (final): 20260806_001 retires chunk_retrievals.outcome — a task-level question stamped
  // on a response-level row, so it never had a denominator. Measured 0 stamps across 108 rows, and
  // the column was unreachable until 2026-08-03, so the zero is not low adoption of a working
  // signal. Recreates chunk_access_stats first (SQLite refuses DROP COLUMN under a view), swapping
  // the view's outcome_balance aggregate for `observed` — the denominator scoring was missing.
  // cited_in_response deliberately SURVIVES: its writer is automatic and merely broken (THE-717).
  "20260806_001_retire_retrieval_outcome.sql",
  // THE-718: 20260806_002 swaps note_quality.outcome_balance for observed_retrievals. SPLIT from
  // _001 because the two touch different tables and note_quality arrives 14 migrations later, so a
  // combined migration could not be applied to any prefix that has chunk_retrievals without it.
  "20260806_002_note_quality_observed.sql",
  // THE-718 (final): 20260806_003 renames agent_episodes.outcome -> task_result. Kept, not
  // retired — an episode IS the task, so the axis is coherent here. The old name claimed "parity
  // with chunk_retrievals outcome axis" and collided with both agent_episodes.status (dispatch
  // outcome) and cache.db's unrelated jobs.outcome.
  "20260806_003_agent_episodes_task_result.sql",
  // THE-717 follow-up: 20260806_004 splits `judge_errors` out of `parse_failures`. A judge that is
  // DOWN was recorded identically to a judge that is BABBLING — both live passes logged 3/3
  // "parse failures" that were every one of them an HTTP 404. The kill switch still trips on the
  // SUM, so a total outage keeps aborting; only the reporting is split.
  "20260806_004_citation_runs_judge_errors.sql",
  // THE-744: 20260806_005 adds citation_runs.entries. A pass over an EMPTY transcript index wrote
  // no row at all — openCitationRun is per-ENTRY, so zero entries meant zero passes and zero rows,
  // and a healthy scheduler with nothing to do looked identical to one that was never registered.
  "20260806_005_citation_runs_entries.sql",
  // THE-746: 20260806_006 records WHY evaluateEpisodes reached each eligibility verdict, plus the
  // policy VERSION that produced it. THE-672's measurement had to diff two hand-made database
  // copies to learn which rule fired; versioning separates a later policy change from a data one.
  "20260806_006_episode_eligibility_reason.sql",
  // THE-839: 20260816_001 corrects `episode_type`, which had been the literal 'tool_call' for every
  // captured operation since 20260711_002 — 630 rows, one distinct value, no information. 192 of
  // them (30.5%) are MCP protocol methods arriving through dispatchResource, not tool calls. The
  // producer now carries the kind; this backfills the history. Classifying by name is legitimate
  // HERE (once, over an inspected closed set) and refused at runtime, because SEP-986 permits `/`
  // in tool names — the header carries the full argument.
  "20260816_001_episode_type_structural.sql",
  // THE-726: 20260816_002 adds `verdict_at`, the timestamp half of a task verdict. Paired with
  // `session_id` it is the WINDOW IDENTITY — which rows share one judgement — without which the
  // preference extractor reads N projected rows as N independent observations (measured: 4.82
  // dispatches per session, so one 18-dispatch task would take 18 of its 40 evidence slots).
  "20260816_002_episode_verdict_at.sql",
  // THE-634 (adversarial review): 20260818_002 recreates chunk_access_stats to exclude
  // surface_type = 'advisory' rows — the proactive-advisory sweep's pushed-not-retrieved rows were
  // silently bumping access_count/last_accessed_at, clearing note_quality's stale_access flag and
  // inflating metrics.ts's knowledge-health scorecard. Fixed at the view, not at each reader.
  "20260818_002_chunk_access_stats_excludes_advisory.sql",
] as const;

/** Registered migration version = the first two underscore-delimited segments of the filename. */
export function versionOf(file: string): string {
  return file.split("_").slice(0, 2).join("_");
}
