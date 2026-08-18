// THE-636 — the vendor-neutral derived-plane bundle format.
//
// Row shapes here are a DELIBERATE mirror of the 9 experiential tables' current CREATE TABLE
// definitions (doctor/table-spec.ts's `experientialTableSpec` is the canonical list of which
// tables those are). Re-derive them from the live schema — `PRAGMA table_info(<table>)` against
// a freshly-migrated experiential.db — before trusting this file's copy if enough migrations have
// landed since that a 10th table or a renamed column could have shipped; nothing here is
// generated, so nothing re-derives it automatically.
//
// Every row is validated against these schemas on import BEFORE any write happens (THE-636 item
// 1: "a bundle is attacker-supplied data by definition"). Export does not validate its own rows —
// they came straight out of the current schema by construction — but sharing one schema per table
// between export and import means a schema drift shows up as an export TYPE error, not a silent
// mismatch discovered only on import.
import { z } from "zod";
import type { GoalRow } from "./goals";
import type { NoteQualityRow } from "./note-quality";

// Re-exported (not redeclared — check:duplicate-exports treats `export { X } from "./y"` as one
// definition, not a second) so callers can import NoteQualityRow/GoalRow from this module
// alongside the rest of the bundle's row types, without a second source of truth for either shape.
export type { GoalRow, NoteQualityRow };

/** Bumped only on a breaking change to the envelope or a table's row shape. Import refuses any
 *  bundle whose format_version does not exactly match — no silent upgrade path in v1 (item 4). */
export const BUNDLE_FORMAT_VERSION = 1;

export const PreferenceProfileRowSchema = z.object({
  vault_id: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  weight: z.number(),
  version: z.number().int(),
  updated_at: z.number().int(),
  provenance: z.string().nullable(),
});
export type PreferenceProfileRow = z.infer<typeof PreferenceProfileRowSchema>;

// `id` travels for reference only (autoincrement — not a stable cross-install identity).
// Import strips it and re-derives dedup via the natural key (vault_id, ts, key, op, version).
export const PreferenceDeltaRowSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  key: z.string().min(1),
  op: z.enum(["add", "strengthen", "weaken", "retract"]),
  value: z.string().nullable(),
  evidence: z.string().nullable(),
  version: z.number().int(),
  vault_id: z.string(),
});
export type PreferenceDeltaRow = z.infer<typeof PreferenceDeltaRowSchema>;

export const AgentEpisodeRowSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int(),
  vault_id: z.string().nullable(),
  session_id: z.string().nullable(),
  caller: z.string().nullable(),
  channel: z.string().min(1),
  episode_type: z.string().min(1),
  tool: z.string().nullable(),
  status: z.string().min(1),
  error_code: z.string().nullable(),
  duration_ms: z.number().nullable(),
  result_size: z.number().nullable(),
  args_hash: z.string().nullable(),
  args_json: z.string().nullable(),
  secret_scan: z.string().nullable(),
  summary: z.string().nullable(),
  tags: z.string().nullable(),
  task_result: z.number().nullable(),
  eligibility: z.string().min(1),
  trust: z.number().nullable(),
  // blocked is validated as 0 here (see the header note on export filtering) — a bundle
  // containing blocked=1 is either hand-forged or from a buggy exporter, and either way must not
  // be trusted to resurrect content that its own row marks as tombstoned.
  blocked: z.literal(0),
  valid_from: z.number().nullable(),
  valid_until: z.number().nullable(),
  prev_id: z.string().nullable(),
  eligibility_reason: z.string().nullable(),
  eligibility_policy: z.number().nullable(),
  verdict_at: z.number().nullable(),
});
export type AgentEpisodeRow = z.infer<typeof AgentEpisodeRowSchema>;

// NoteQualityRow is note-quality.ts's own row shape, imported rather than redeclared
// (check:duplicate-exports — one fact, one declaration). The `z.ZodType<NoteQualityRow>`
// annotation makes the schema a compile-time check against that shape: a field this zod object
// omits or mistypes is a TYPE ERROR here, not a silent runtime drift between the two.
export const NoteQualityRowSchema: z.ZodType<NoteQualityRow> = z.object({
  vault_id: z.string().min(1),
  path: z.string().min(1),
  computed_at: z.number().int(),
  chunk_count: z.number().int(),
  dup_chunk_count: z.number().int(),
  dup_ratio: z.number().nullable(),
  mtime: z.number().nullable(),
  age_days: z.number().nullable(),
  last_retrieved_at: z.number().nullable(),
  retrievals: z.number().int(),
  citations: z.number().int(),
  in_degree: z.number().int(),
  out_degree: z.number().int(),
  orphan: z.number().int(),
  contradictions_open: z.number().int(),
  tombstoned: z.number().int(),
  quality_score: z.number().nullable(),
  score_version: z.number().int(),
  flags: z.string(),
  observed_retrievals: z.number().int(),
});

export const ChunkRetrievalRowSchema = z.object({
  id: z.string().min(1),
  chunk_id: z.string().min(1),
  retrieved_at: z.number().int(),
  session_id: z.string().nullable(),
  surface_type: z.string().nullable(),
  query_text: z.string().nullable(),
  rank_in_results: z.number().nullable(),
  rerank_score: z.number().nullable(),
  cited_in_response: z.number().nullable(),
  citation_score: z.number().nullable(),
  feedback: z.number().nullable(),
  caller: z.string().nullable(),
  event_group: z.string().nullable(),
  stream_source: z.string().nullable(),
  citation_state: z.enum(["confirmed", "rejected", "candidate", "uncertain"]).nullable(),
});
export type ChunkRetrievalRow = z.infer<typeof ChunkRetrievalRowSchema>;

export const VaultObjectStateRowSchema = z.object({
  object_id: z.string().min(1),
  retrieval_strength: z.number().nullable(),
  storage_strength: z.number().nullable(),
  frequency: z.number().int(),
  last_accessed: z.number().nullable(),
  learned_at: z.number().nullable(),
  valid_from: z.number().nullable(),
  valid_until: z.number().nullable(),
  emotional_weight: z.number(),
  confidence: z.number().nullable(),
  injections: z.number().int(),
  hits: z.number().int(),
  misses: z.number().int(),
  last_hit_at: z.number().nullable(),
  cached_activation_score: z.number().nullable(),
  last_computed_at: z.number().nullable(),
});
export type VaultObjectStateRow = z.infer<typeof VaultObjectStateRowSchema>;

// `id` travels for reference only (autoincrement). Import strips it and dedups on
// (vault_id, computed_at) — a gap-detector pass is identified by which vault and when it ran.
export const GapReportRowSchema = z.object({
  id: z.number().int(),
  vault_id: z.string().min(1),
  computed_at: z.number().int(),
  threshold: z.number(),
  min_results: z.number().int(),
  total: z.number().int(),
  gaps: z.number().int(),
  gap_rate: z.number(),
  items: z.string(),
});
export type GapReportRow = z.infer<typeof GapReportRowSchema>;

// GoalRow is goals.ts's own row shape, imported rather than redeclared (check:duplicate-exports).
// Same `z.ZodType<GoalRow>` compile-time-check pattern as NoteQualityRowSchema above.
export const GoalRowSchema: z.ZodType<GoalRow> = z.object({
  id: z.string().min(1),
  vault_id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["open", "completed", "abandoned", "expired"]),
  source: z.literal("stated"),
  created_at: z.number().int(),
  target_date: z.number().nullable(),
  closed_at: z.number().nullable(),
});

// `details` is already the JSON text stored in the column (see forget.ts's appendForgetLog) —
// kept as a string here rather than re-parsed, so a bundle round-trips it byte-for-byte until
// import re-derives a fresh hash chain (see context-bundle.ts).
export const ForgetLogRowSchema = z.object({
  seq: z.number().int(),
  ts: z.number().int(),
  kind: z.enum(["episode", "note"]),
  target: z.string().min(1),
  mode: z.enum(["tombstone", "erase"]),
  details: z.string().nullable(),
  prev_hash: z.string(),
  hash: z.string(),
});
export type ForgetLogRow = z.infer<typeof ForgetLogRowSchema>;

export const ContextBundleTablesSchema = z.object({
  preference_profile: z.array(PreferenceProfileRowSchema),
  preference_deltas: z.array(PreferenceDeltaRowSchema),
  agent_episodes: z.array(AgentEpisodeRowSchema),
  note_quality: z.array(NoteQualityRowSchema),
  chunk_retrievals: z.array(ChunkRetrievalRowSchema),
  vault_object_state: z.array(VaultObjectStateRowSchema),
  gap_reports: z.array(GapReportRowSchema),
  goals: z.array(GoalRowSchema),
  forget_log: z.array(ForgetLogRowSchema),
});
export type ContextBundleTables = z.infer<typeof ContextBundleTablesSchema>;

/**
 * The bundle envelope. `vault` is the vault id narrowed at export, or the literal "*" for a
 * deployment-wide export (no --vault). `score_version` travels so an importer can tell it is
 * mixing note_quality score generations (item 4) rather than silently blending them.
 */
export const ContextBundleSchema = z.object({
  format_version: z.number().int(),
  exported_at: z.number().int(),
  server_version: z.string(),
  vault: z.string(),
  score_version: z.number().int(),
  tables: ContextBundleTablesSchema,
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

/** The 9 experiential tables that have no `vault_id` column to filter a `--vault` export by, and
 *  so are always exported/considered in full regardless of `--vault`: `chunk_retrievals` and
 *  `vault_object_state` key by chunk/object id "by value" (the membrane: no cross-file FK),
 *  globally, across every vault in the deployment (doctor/table-spec.ts's grouping). `forget_log`
 *  joins them here for a narrower reason — it DOES conceptually belong to whichever vault owned
 *  the deleted episode/note, but the table itself carries no `vault_id` column to filter on, and
 *  guessing one from `target` (a bare episode id or note path) would be exactly the kind of silent
 *  lossy filter THE-636's design note warns against. A `--vault` export therefore always includes
 *  the FULL forget_log — never a guessed-at subset — so an importer's reconciliation check (see
 *  context-bundle.ts) always has the complete picture to reconcile against, not a filtered one
 *  that could hide a forget that happened in a different vault.
 */
export const ALWAYS_FULL_TABLES = ["chunk_retrievals", "vault_object_state", "forget_log"] as const;
