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
] as const;

/**
 * experiential.db chain (cli.ts).
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
] as const;

/** Registered migration version = the first two underscore-delimited segments of the filename. */
export function versionOf(file: string): string {
  return file.split("_").slice(0, 2).join("_");
}
