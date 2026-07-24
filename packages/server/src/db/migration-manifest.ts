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
] as const;

/**
 * experiential.db chain (cli.ts).
 *
 * THE-222: 20260712_001 is the versioned preference profile (typed-delta updates only) for the
 * reflect pass. THE-44: 20260712_002 is derive-don't-mutate access instrumentation
 * (chunk_access_stats view). THE-239: 20260712_003 is the hash-chained forget audit log
 * (dependency-aware deletion). THE-461: 20260723_001 is the one-row watermark for the incremental
 * ACT-R activation recompute.
 */
export const EXPERIENTIAL_MIGRATION_FILES = [
  "20260626_001_experiential_init.sql",
  "20260711_001_experiential_outcome.sql",
  "20260711_002_agent_episodes.sql",
  "20260712_001_preference_profile.sql",
  "20260712_002_access_views.sql",
  "20260712_003_forget_log.sql",
  "20260723_001_activation_watermark.sql",
] as const;

/** Registered migration version = the first two underscore-delimited segments of the filename. */
export function versionOf(file: string): string {
  return file.split("_").slice(0, 2).join("_");
}
