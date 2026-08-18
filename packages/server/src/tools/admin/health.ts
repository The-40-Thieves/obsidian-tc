import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";

export interface IndexHealthSnapshot {
  /** Boot reconcile lifecycle: `pending` until it settles, then `ok`, or `degraded` if any vault
   *  failed to reconcile. Non-identifying. */
  reconcile: "pending" | "ok" | "degraded";
  /** When the boot reconcile settled (ms epoch), or null while still pending. */
  reconcile_at: number | null;
  /** Count of index-on-write failures swallowed since boot (best-effort reindex/deindex). */
  write_failures: number;
  /** THE-291: the notes/FTS metadata pass completed (independent of embed success). */
  notes_ready?: boolean;
  /** Per-vault reconcile errors + last write error — authenticated callers only (may name paths). */
  detail?: {
    reconcile_errors: Array<{ vault: string; error: string }>;
    last_write_error?: string;
    /** THE-457: fail-open audit writes that threw (locked DB / disk full). */
    audit_write_failures?: number;
    /** THE-458 (audit #5): index-on-write coordinator — distinct paths queued/in-flight. */
    index_queue_depth?: number;
    /** THE-458 (audit #5): index-on-write coordinator — drains currently running a handler. */
    index_queue_active?: number;
    /** THE-458 (audit #5): times the index-on-write queue crossed queueMax (backpressure edges). */
    index_queue_backpressures?: number;
  };
}

export interface HealthInfo {
  status: "ok";
  name: "obsidian-tc";
  version: string;
  /** True when the compiled native search module is loaded (accelerated path). Non-identifying. */
  native_loaded: boolean;
  /** True when sqlite-vec loaded on the shared cache.db connection at boot. Non-identifying. */
  vec_enabled: boolean;
  /** True when FTS5 (notes_fts) is AVAILABLE on this connection (THE-291). Non-identifying.
   *
   *  THE-696: availability, NOT integrity — and the difference is not academic. This field stayed
   *  `true` throughout the period the live notes_fts index was malformed and answering MATCH
   *  queries with silently incomplete results. It cannot go false when the index is broken, so it
   *  is not a signal about index health. Soundness is reported by `doctor --probe`
   *  (`search.notes_fts`), which runs the FTS5 integrity-check; boot-time detection and repair is
   *  opt-in via OBSIDIAN_TC_VERIFY_FTS=1. */
  fts_enabled: boolean;
  /** Number of configured vaults (always present, non-identifying). */
  vault_count: number;
  /** Vault id list — only for authenticated callers (ids are deployment-internal). */
  vaults?: string[];
  uptime_ms: number;
  /** Search-index health (THE-288). Always present; `detail` (per-vault reconcile errors + last
   *  write error) is authenticated-only since messages may name paths. */
  index?: IndexHealthSnapshot;
  /** #14: durable job-queue depth + dead-letter count. Always present when wired; counts are
   *  non-identifying (no paths/ids), so it is not auth-gated. A non-zero `failed` = a workload
   *  persistently dead-lettering. */
  job_queue?: {
    queued: number;
    running: number;
    retrying: number;
    failed: number;
    oldest_queued_age_ms: number | null;
  };
}

/** THE-491: the `server_health` index block, thinned to a named, agent-discoverable reader —
 *  "can I trust the search index right now, before I pay for an expensive search?" — plus
 *  chunks_upserted from the most recent index_vault call (absent -> null, never indexed this
 *  process lifetime). No `detail`: that sub-object is authenticated-only on server_health because
 *  its messages may name paths; this tool stays scope-free like server_health itself, so it
 *  carries only the non-identifying fields already exposed unauthenticated there. */
/** THE-645: in-flight progress for a currently-running index_vault call, updated once per
 *  completed flush() batch (never per-chunk — see IndexVaultArgs.onProgress's perf-gate note). */
export interface IndexInFlightInfo {
  vault: string;
  /** Walk total, known up front, or -1 when the run used the streaming walk (total unknown until
   *  the walk finishes). */
  notesSeen: number;
  notesProcessed: number;
  chunksUpserted: number;
  /** epoch ms the run started, for an elapsed/ETA computation by the reader. */
  startedAt: number;
}

export interface IndexStatusInfo {
  reconcile: "pending" | "ok" | "degraded";
  reconcile_at: number | null;
  write_failures: number;
  notes_ready: boolean;
  vec_enabled: boolean;
  fts_enabled: boolean;
  /** chunks_upserted from the last index_vault tool call this process, or null if none yet. */
  chunks_upserted: number | null;
  /** THE-645: progress of an index_vault call currently in flight for this process, or absent
   *  when none is running. */
  in_flight?: IndexInFlightInfo;
}

// THE-417: mirrors this file's own IndexStatusInfo/HealthInfo/IndexHealthSnapshot interfaces
// verbatim — both tools already had a hand-written return type at the factory boundary, so the
// schema is a direct transcription rather than something derived from a handler's return
// statements.
const IndexInFlightOutput = z.object({
  vault: z.string(),
  notesSeen: z.number(),
  notesProcessed: z.number(),
  chunksUpserted: z.number(),
  startedAt: z.number(),
});

const IndexStatusOutput = z.object({
  reconcile: z.enum(["pending", "ok", "degraded"]),
  reconcile_at: z.number().nullable(),
  write_failures: z.number(),
  notes_ready: z.boolean(),
  vec_enabled: z.boolean(),
  fts_enabled: z.boolean(),
  chunks_upserted: z.number().nullable(),
  in_flight: IndexInFlightOutput.optional(),
});

const IndexHealthSnapshotOutput = z.object({
  reconcile: z.enum(["pending", "ok", "degraded"]),
  reconcile_at: z.number().nullable(),
  write_failures: z.number(),
  notes_ready: z.boolean().optional(),
  // authenticated-callers-only (may name paths); absent for an unauthenticated server_health call.
  detail: z
    .object({
      reconcile_errors: z.array(z.object({ vault: z.string(), error: z.string() })),
      last_write_error: z.string().optional(),
      audit_write_failures: z.number().optional(),
      index_queue_depth: z.number().optional(),
      index_queue_active: z.number().optional(),
      index_queue_backpressures: z.number().optional(),
    })
    .optional(),
});

const HealthInfoOutput = z.object({
  status: z.literal("ok"),
  name: z.literal("obsidian-tc"),
  version: z.string(),
  native_loaded: z.boolean(),
  vec_enabled: z.boolean(),
  fts_enabled: z.boolean(),
  vault_count: z.number(),
  // authenticated-callers-only (F3): vault ids are deployment-internal.
  vaults: z.array(z.string()).optional(),
  uptime_ms: z.number(),
  index: IndexHealthSnapshotOutput.optional(),
  job_queue: z
    .object({
      queued: z.number(),
      running: z.number(),
      retrying: z.number(),
      failed: z.number(),
      oldest_queued_age_ms: z.number().nullable(),
    })
    .optional(),
});

export function createIndexStatusTool(opts: {
  vecEnabled: boolean;
  ftsEnabled: boolean;
  getIndexHealth: () => Omit<IndexHealthSnapshot, "detail">;
  getLastChunksUpserted: () => number | null;
  /** THE-645: progress of an index_vault call in flight right now, or null/absent when none is
   *  running. Optional so a caller predating this ticket keeps compiling. */
  getInFlightProgress?: () => IndexInFlightInfo | null;
}): ToolDefinition<Record<string, never>, IndexStatusInfo> {
  return {
    name: "get_index_status",
    domain: "admin",
    description:
      "Search-index health at a glance: boot reconcile state, write-failure count, notes/FTS/vec readiness, chunks_upserted from the last index_vault call, and in-flight progress while one is currently running. Read-only — self-diagnose before spending on an expensive search.",
    inputSchema: z.object({}).strict(),
    outputSchema: IndexStatusOutput,
    requiredScopes: [],
    handler: () => {
      const snap = opts.getIndexHealth();
      const inFlight = opts.getInFlightProgress?.() ?? null;
      return {
        reconcile: snap.reconcile,
        reconcile_at: snap.reconcile_at,
        write_failures: snap.write_failures,
        notes_ready: snap.notes_ready ?? false,
        vec_enabled: opts.vecEnabled,
        fts_enabled: opts.ftsEnabled,
        chunks_upserted: opts.getLastChunksUpserted(),
        ...(inFlight ? { in_flight: inFlight } : {}),
      };
    },
  };
}

export function createHealthTool(opts: {
  version: string;
  vaults: string[];
  startedAt: number;
  nativeLoaded: boolean;
  vecEnabled: boolean;
  /** Optional so existing harnesses stay source-compatible; absent -> false. */
  ftsEnabled?: boolean;
  /** THE-288: returns a live index-health snapshot at call time, shaped by caller auth. */
  getIndexHealth?: (authenticated: boolean) => IndexHealthSnapshot;
  /** #14: live job-queue stats at call time. Counts are non-identifying, so the block is always
   *  present when the accessor is wired (unauthenticated-safe, like vec_enabled). */
  getJobQueueStats?: () => {
    queued: number;
    running: number;
    retrying: number;
    failed: number;
    oldestQueuedAgeMs: number | null;
  };
}): ToolDefinition<Record<string, never>, HealthInfo> {
  return {
    name: "server_health",
    domain: "admin",
    description:
      "Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path.",
    inputSchema: z.object({}).strict(),
    outputSchema: HealthInfoOutput,
    requiredScopes: [],
    // requiredScopes [] keeps this an unauthenticated liveness probe, but the vault-id list is
    // emitted only to authenticated callers (F3): ids are deployment-internal. The native/vec
    // capability flags are non-identifying, so they stay in the always-present payload.
    handler: (_input, ctx) => ({
      status: "ok",
      name: "obsidian-tc",
      version: opts.version,
      native_loaded: opts.nativeLoaded,
      vec_enabled: opts.vecEnabled,
      fts_enabled: opts.ftsEnabled ?? false,
      vault_count: opts.vaults.length,
      ...(ctx.authenticated ? { vaults: opts.vaults } : {}),
      uptime_ms: Date.now() - opts.startedAt,
      ...(opts.getIndexHealth ? { index: opts.getIndexHealth(ctx.authenticated) } : {}),
      ...(opts.getJobQueueStats
        ? (() => {
            const s = opts.getJobQueueStats?.();
            if (!s) return {};
            return {
              job_queue: {
                queued: s.queued,
                running: s.running,
                retrying: s.retrying,
                failed: s.failed, // dead-letter count
                oldest_queued_age_ms: s.oldestQueuedAgeMs,
              },
            };
          })()
        : {}),
    }),
  };
}
