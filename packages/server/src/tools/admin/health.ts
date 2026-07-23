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
    /** THE-457: chunks dropped from the bounded contradiction queue under backpressure. */
    contradictions_dropped?: number;
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
  /** True when FTS5 (notes_fts) is available on this connection (THE-291). Non-identifying. */
  fts_enabled: boolean;
  /** Number of configured vaults (always present, non-identifying). */
  vault_count: number;
  /** Vault id list — only for authenticated callers (ids are deployment-internal). */
  vaults?: string[];
  uptime_ms: number;
  /** Search-index health (THE-288). Always present; `detail` (per-vault reconcile errors + last
   *  write error) is authenticated-only since messages may name paths. */
  index?: IndexHealthSnapshot;
}

/** THE-491: the `server_health` index block, thinned to a named, agent-discoverable reader —
 *  "can I trust the search index right now, before I pay for an expensive search?" — plus
 *  chunks_upserted from the most recent index_vault call (absent -> null, never indexed this
 *  process lifetime). No `detail`: that sub-object is authenticated-only on server_health because
 *  its messages may name paths; this tool stays scope-free like server_health itself, so it
 *  carries only the non-identifying fields already exposed unauthenticated there. */
export interface IndexStatusInfo {
  reconcile: "pending" | "ok" | "degraded";
  reconcile_at: number | null;
  write_failures: number;
  notes_ready: boolean;
  vec_enabled: boolean;
  fts_enabled: boolean;
  /** chunks_upserted from the last index_vault tool call this process, or null if none yet. */
  chunks_upserted: number | null;
}

export function createIndexStatusTool(opts: {
  vecEnabled: boolean;
  ftsEnabled: boolean;
  getIndexHealth: () => Omit<IndexHealthSnapshot, "detail">;
  getLastChunksUpserted: () => number | null;
}): ToolDefinition<Record<string, never>, IndexStatusInfo> {
  return {
    name: "get_index_status",
    description:
      "Search-index health at a glance: boot reconcile state, write-failure count, notes/FTS/vec readiness, and chunks_upserted from the last index_vault call. Read-only — self-diagnose before spending on an expensive search.",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    handler: () => {
      const snap = opts.getIndexHealth();
      return {
        reconcile: snap.reconcile,
        reconcile_at: snap.reconcile_at,
        write_failures: snap.write_failures,
        notes_ready: snap.notes_ready ?? false,
        vec_enabled: opts.vecEnabled,
        fts_enabled: opts.ftsEnabled,
        chunks_upserted: opts.getLastChunksUpserted(),
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
}): ToolDefinition<Record<string, never>, HealthInfo> {
  return {
    name: "server_health",
    description:
      "Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path.",
    inputSchema: z.object({}).strict(),
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
    }),
  };
}
