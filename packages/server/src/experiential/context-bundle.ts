// Context portability: export/import the derived plane (experiential.db) as a vendor-neutral
// bundle. CLI-only (cli/commands/context-export.ts, context-import.ts), never dispatched through
// `registry.dispatch` or exposed as an MCP tool — mirrors the `forget.ts` precedent for
// admin/operator-only, filesystem-touching commands. THE-636. See
// docs/design/experiential-context-bundle.md.
//
// "Forget wins over import" holds in both directions: an episode the TARGET has already forgotten
// is never resurrected by an import naming it (existence check against the target's own
// forget_log, no timestamp comparison — a timestamp gate is wrong across machines with independent
// clocks), and an imported forget_log entry retroactively blocks/scrubs any matching episode
// already in the target, including ones a different, earlier import brought in.
//
// Vault ids have no cross-install identity, and derived chunk ids are a hash of that bare label —
// two installs each with a vault called "main" hash identically. `remapBundleVault` (`--vault`)
// remaps vault-scoped rows to a named target vault and refuses a bundle naming more than one source
// vault; `chunk_retrievals`/`vault_object_state` carry no vault_id at all, so those are ground-
// truthed against the target's own indexed `cache.db.chunks` instead (`skipped_unmatched` when
// absent).
//
// Idempotency: every table dedups on a natural key before writing, never a bare insert-and-hope —
// see `importDeduped`. Re-importing the same bundle a second time writes nothing new anywhere.
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import {
  type AgentEpisodeRow,
  BUNDLE_FORMAT_VERSION,
  type ChunkRetrievalRow,
  type ContextBundle,
  ContextBundleSchema,
  type ContextBundleTables,
  type ForgetLogRow,
  type GapReportRow,
  type GoalRow,
  type NoteQualityRow,
  type PreferenceDeltaRow,
  type PreferenceProfileRow,
  type VaultObjectStateRow,
} from "./context-bundle-schema";
import { appendForgetLog } from "./forget";
import { SCORE_VERSION } from "./note-quality";

export interface ExportOptions {
  /** Narrow the 6 vault-scoped-and-filterable tables to one vault. `chunk_retrievals` and
   *  `vault_object_state` have no `vault_id` column to filter by at all (they key "by value",
   *  globally, across every vault in the deployment); `forget_log` conceptually belongs to
   *  whichever vault owned the deleted episode/note, but also carries no `vault_id` column, and
   *  guessing one from `target` (a bare episode id or note path) would be exactly the kind of
   *  silent lossy filter THE-636's design note warns against. All three are therefore ALWAYS
   *  exported in full regardless of `--vault`. Absent -> deployment-wide export, `vault: "*"`. */
  vaultId?: string;
  nowMs: number;
  serverVersion: string;
}

// THE-891: scope_caller travels too — dropping it here would silently re-scope every exported
// caller-partitioned preference to the shared partition on any export/import round trip, which is
// exactly the bleed this ticket closes.
const PREFERENCE_PROFILE_COLS =
  "vault_id, scope_caller, key, value, weight, version, updated_at, provenance";
const AGENT_EPISODE_COLS =
  "id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, error_code, " +
  "duration_ms, result_size, args_hash, args_json, secret_scan, summary, tags, task_result, " +
  "eligibility, trust, blocked, valid_from, valid_until, prev_id, eligibility_reason, " +
  "eligibility_policy, verdict_at";
const NOTE_QUALITY_COLS =
  "vault_id, path, computed_at, chunk_count, dup_chunk_count, dup_ratio, mtime, age_days, " +
  "last_retrieved_at, retrievals, citations, in_degree, out_degree, orphan, contradictions_open, " +
  "tombstoned, quality_score, score_version, flags, observed_retrievals";
const CHUNK_RETRIEVAL_COLS =
  "id, chunk_id, retrieved_at, session_id, surface_type, query_text, rank_in_results, " +
  "rerank_score, cited_in_response, citation_score, feedback, caller, event_group, " +
  "stream_source, citation_state";
const VAULT_OBJECT_STATE_COLS =
  "object_id, retrieval_strength, storage_strength, frequency, last_accessed, learned_at, " +
  "valid_from, valid_until, emotional_weight, confidence, injections, hits, misses, " +
  "last_hit_at, cached_activation_score, last_computed_at";
const GOAL_COLS = "id, vault_id, text, status, source, created_at, target_date, closed_at";

/** Read the 9 experiential tables into a versioned envelope. `agent_episodes` filters
 *  `blocked = 0` UNCONDITIONALLY (no `--include-blocked` escape hatch — see context-bundle-schema
 *  and the ticket's item 3): a tombstoned episode never enters a bundle in the first place.
 *
 *  `preference_profile`/`preference_deltas` carry `scope_caller` (THE-891), so a bundle exports
 *  learned state that CROSSES caller partitions within the vault(s) it covers, unfiltered — human-
 *  scoped and caller-scoped rows alike. Deliberate, not a gap: this is the same admin/operator-only,
 *  CLI-only, `registry.dispatch`-bypassing surface the module header establishes, reachable only by
 *  an operator running `obsidian-tc context-export` on the box — never through the MCP tool surface
 *  `preferenceProfile`'s own `admin:workspace` gate protects. No second, redundant scope check here. */
export function exportContextBundle(edb: Database, opts: ExportOptions): ContextBundle {
  const v = opts.vaultId;

  const preference_profile = (
    v
      ? edb
          .prepare(`SELECT ${PREFERENCE_PROFILE_COLS} FROM preference_profile WHERE vault_id = ?`)
          .all(v)
      : edb.prepare(`SELECT ${PREFERENCE_PROFILE_COLS} FROM preference_profile`).all()
  ) as PreferenceProfileRow[];

  const preference_deltas = (
    v
      ? edb
          .prepare(
            "SELECT id, ts, key, op, value, evidence, version, vault_id, scope_caller FROM preference_deltas WHERE vault_id = ?",
          )
          .all(v)
      : edb
          .prepare(
            "SELECT id, ts, key, op, value, evidence, version, vault_id, scope_caller FROM preference_deltas",
          )
          .all()
  ) as PreferenceDeltaRow[];

  const agent_episodes = (
    v
      ? edb
          .prepare(
            `SELECT ${AGENT_EPISODE_COLS} FROM agent_episodes WHERE blocked = 0 AND vault_id = ?`,
          )
          .all(v)
      : edb.prepare(`SELECT ${AGENT_EPISODE_COLS} FROM agent_episodes WHERE blocked = 0`).all()
  ) as AgentEpisodeRow[];

  const note_quality = (
    v
      ? edb.prepare(`SELECT ${NOTE_QUALITY_COLS} FROM note_quality WHERE vault_id = ?`).all(v)
      : edb.prepare(`SELECT ${NOTE_QUALITY_COLS} FROM note_quality`).all()
  ) as NoteQualityRow[];

  const gap_reports = (
    v
      ? edb
          .prepare(
            "SELECT id, vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items FROM gap_reports WHERE vault_id = ?",
          )
          .all(v)
      : edb
          .prepare(
            "SELECT id, vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items FROM gap_reports",
          )
          .all()
  ) as GapReportRow[];

  const goals = (
    v
      ? edb.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE vault_id = ?`).all(v)
      : edb.prepare(`SELECT ${GOAL_COLS} FROM goals`).all()
  ) as GoalRow[];

  // ALWAYS FULL — no vault_id column to filter by (chunk_retrievals, vault_object_state), or a
  // deliberate choice not to guess one from `target` (forget_log). See ExportOptions.vaultId above.
  const chunk_retrievals = edb
    .prepare(`SELECT ${CHUNK_RETRIEVAL_COLS} FROM chunk_retrievals`)
    .all() as ChunkRetrievalRow[];
  const vault_object_state = edb
    .prepare(`SELECT ${VAULT_OBJECT_STATE_COLS} FROM vault_object_state`)
    .all() as VaultObjectStateRow[];
  const forget_log = edb
    .prepare(
      "SELECT seq, ts, kind, target, mode, details, prev_hash, hash FROM forget_log ORDER BY seq ASC",
    )
    .all() as ForgetLogRow[];

  return {
    format_version: BUNDLE_FORMAT_VERSION,
    exported_at: opts.nowMs,
    server_version: opts.serverVersion,
    vault: v ?? "*",
    score_version: SCORE_VERSION,
    tables: {
      preference_profile,
      preference_deltas,
      agent_episodes,
      note_quality,
      chunk_retrievals,
      vault_object_state,
      gap_reports,
      goals,
      forget_log,
    },
  };
}

/** Parse + validate an unknown value as a context bundle. format_version is checked BEFORE the
 *  full per-row schema validation and reported as its own error (item 4: "no silent upgrade path
 *  in v1") — a version mismatch is a version problem, not a generic shape problem, and a bundle
 *  from a newer/older format may not even parse as this version's row shapes. */
export function validateContextBundle(
  raw: unknown,
): { ok: true; bundle: ContextBundle } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || !("format_version" in raw)) {
    return { ok: false, error: "not a context bundle: missing format_version" };
  }
  const fv = (raw as { format_version: unknown }).format_version;
  if (fv !== BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `format_version mismatch: bundle is v${String(fv)}, this importer expects v${BUNDLE_FORMAT_VERSION}`,
    };
  }
  const parsed = ContextBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    return {
      ok: false,
      error: `bundle failed schema validation at ${path}: ${issue?.message ?? "invalid"}`,
    };
  }
  return { ok: true, bundle: parsed.data };
}

const VAULT_SCOPED_TABLE_NAMES = [
  "preference_profile",
  "preference_deltas",
  "gap_reports",
  "goals",
  "note_quality",
] as const;

/**
 * THE-636 review fix (BLOCKER 2a) — see the module header's "CROSS-INSTALL VAULT IDENTITY" note.
 *
 * Called AFTER `validateContextBundle` and BEFORE `importContextBundle`, so a refusal here is
 * still a hard error with nothing written — no store handle has been opened yet at this point in
 * the CLI command.
 *
 * `targetVault` undefined -> no-op (rows keep the bundle's verbatim vault_id — the deployment-
 * migration case). `targetVault` given -> derive the bundle's ACTUAL source vault from the rows
 * themselves (never trust the envelope's `vault` label alone: it is exporter-supplied and a "*"
 * deployment-wide export can legitimately span more than one vault), refuse if more than one
 * distinct source vault is present, and otherwise remap every vault-scoped row's `vault_id` (plus
 * `agent_episodes`' nullable one, left null when absent — a null vault_id means "not vault-scoped
 * at capture", not "belongs to the source vault") to `targetVault`.
 */
export function remapBundleVault(
  bundle: ContextBundle,
  targetVault: string | undefined,
): { ok: true; bundle: ContextBundle } | { ok: false; error: string } {
  if (targetVault === undefined) return { ok: true, bundle };

  const sourceVaults = new Set<string>();
  for (const name of VAULT_SCOPED_TABLE_NAMES) {
    for (const row of bundle.tables[name]) sourceVaults.add(row.vault_id);
  }
  for (const row of bundle.tables.agent_episodes) {
    if (row.vault_id !== null) sourceVaults.add(row.vault_id);
  }

  if (sourceVaults.size > 1) {
    return {
      ok: false,
      error:
        `--vault ${targetVault} requires a bundle that names a single source vault, but its ` +
        `vault-scoped tables name ${sourceVaults.size} distinct source vaults ` +
        `(${[...sourceVaults].sort().join(", ")}) — "the" source vault is undefined, so a single ` +
        `target cannot honestly stand in for all of them. Re-export with --vault to narrow to one ` +
        `source vault first.`,
    };
  }

  return {
    ok: true,
    bundle: {
      ...bundle,
      tables: {
        ...bundle.tables,
        preference_profile: bundle.tables.preference_profile.map((r) => ({
          ...r,
          vault_id: targetVault,
        })),
        preference_deltas: bundle.tables.preference_deltas.map((r) => ({
          ...r,
          vault_id: targetVault,
        })),
        gap_reports: bundle.tables.gap_reports.map((r) => ({ ...r, vault_id: targetVault })),
        goals: bundle.tables.goals.map((r) => ({ ...r, vault_id: targetVault })),
        note_quality: bundle.tables.note_quality.map((r) => ({ ...r, vault_id: targetVault })),
        agent_episodes: bundle.tables.agent_episodes.map((r) =>
          r.vault_id === null ? r : { ...r, vault_id: targetVault },
        ),
      },
    },
  };
}

export interface TableImportStats {
  imported: number;
  skipped_duplicate: number;
  /** Only ever non-zero for agent_episodes — see the module header, direction (a). */
  skipped_forgotten: number;
  /** Only ever non-zero for chunk_retrievals/vault_object_state — the ground-truth chunk-id
   *  check the module header's "CROSS-INSTALL VAULT IDENTITY" note describes (BLOCKER 2b). */
  skipped_unmatched: number;
}
export type ImportStatsByTable = Record<keyof ContextBundleTables, TableImportStats>;
export interface ImportResult {
  tables: ImportStatsByTable;
  dry_run: boolean;
}

function zeroStats(): TableImportStats {
  return { imported: 0, skipped_duplicate: 0, skipped_forgotten: 0, skipped_unmatched: 0 };
}

/**
 * Dedup on a NATURAL KEY, not on "insert and see if it throws": every table here either has no
 * meaningful cross-install id (preference_deltas, gap_reports — both autoincrement, stripped on
 * import) or an id whose PK collision is exactly the natural key (agent_episodes.id,
 * goals.id, chunk_retrievals.id, vault_object_state.object_id, the (vault_id,scope_caller,key)/
 * (vault_id,path) composite PKs). Checking existence explicitly rather than relying on `INSERT OR IGNORE`'s PK
 * semantics makes the SAME code correct for both cases, and means a genuine constraint violation
 * (a CHECK failing) still throws instead of being silently swallowed as "duplicate".
 */
function importDeduped(
  edb: Database,
  existsSql: string,
  existsParams: unknown[],
  insertSql: string,
  insertParams: unknown[],
  dryRun: boolean,
): "imported" | "skipped_duplicate" {
  const exists = edb.prepare(existsSql).get(...existsParams);
  if (exists) return "skipped_duplicate";
  if (!dryRun) edb.prepare(insertSql).run(...insertParams);
  return "imported";
}

/**
 * Apply a validated bundle to `edb`. Whole-bundle transaction (BEGIN/COMMIT/ROLLBACK, mirroring
 * forgetEpisode/forgetNote's own discipline): callers MUST validate with `validateContextBundle`
 * (and, if remapping, `remapBundleVault`) first — this function assumes the bundle already
 * matches the current row schemas and has its final vault_id values, so a bad row here is a
 * caller bug, not an untrusted-input path (those checks already happened, before any write, in
 * the CLI command).
 *
 * `cacheDb` is the target's cache.db — read-only here, used ONLY for the `chunk_retrievals`/
 * `vault_object_state` ground-truth chunk-id check (BLOCKER 2b, module header). It is never
 * written by this function; `chunk_retrievals`/`vault_object_state` themselves live in `edb`.
 *
 * `dryRun` runs every dedup/ground-truth check but skips every write — nothing in `edb` changes,
 * and no transaction is opened (there is nothing to roll back).
 */
export function importContextBundle(
  edb: Database,
  cacheDb: Database,
  bundle: ContextBundle,
  opts: { dryRun?: boolean } = {},
): ImportResult {
  const dryRun = !!opts.dryRun;
  const stats: ImportStatsByTable = {
    preference_profile: zeroStats(),
    preference_deltas: zeroStats(),
    agent_episodes: zeroStats(),
    note_quality: zeroStats(),
    chunk_retrievals: zeroStats(),
    vault_object_state: zeroStats(),
    gap_reports: zeroStats(),
    goals: zeroStats(),
    forget_log: zeroStats(),
  };

  const run = (): void => {
    // 1. forget_log FIRST — direction (b): a freshly-imported forget event must be able to
    //    retroactively block content that arrives later in this same pass (agent_episodes, step 2)
    //    or already existed in the target before this import ran.
    for (const row of bundle.tables.forget_log) {
      const exists = edb
        .prepare(
          "SELECT 1 FROM forget_log WHERE kind = ? AND target = ? AND mode = ? AND ts = ? LIMIT 1",
        )
        .get(row.kind, row.target, row.mode, row.ts);
      if (exists) {
        stats.forget_log.skipped_duplicate++;
        continue;
      }
      if (!dryRun) {
        // THE-636 review fix (item c, "minor gap"): mark this row as import-derived, in the
        // EXISTING `details` JSON column — no migration authorized or needed. Without this, a
        // native forget and an imported one are byte-for-byte indistinguishable once appended,
        // which matters for an operator auditing which entries this install itself decided vs.
        // which arrived from elsewhere. `imported_from`/`imported_at` piggyback on the same field
        // `already_blocked`/`scrubbed`/etc. already use for this kind of free-form provenance.
        const parsedDetails = row.details
          ? (JSON.parse(row.details) as Record<string, unknown>)
          : {};
        appendForgetLog(edb, {
          ts: row.ts,
          kind: row.kind,
          target: row.target,
          mode: row.mode,
          details: {
            ...parsedDetails,
            imported: true,
            imported_from: bundle.server_version,
            imported_at: Date.now(),
          },
        });
        if (row.kind === "episode") {
          edb
            .prepare(
              "UPDATE agent_episodes SET blocked = 1, valid_until = COALESCE(valid_until, ?) WHERE id = ? AND blocked = 0",
            )
            .run(row.ts, row.target);
          if (row.mode === "erase") {
            edb
              .prepare(
                "UPDATE agent_episodes SET args_json = NULL, summary = NULL, tags = NULL, error_code = NULL WHERE id = ?",
              )
              .run(row.target);
          }
        }
      }
      stats.forget_log.imported++;
    }

    // 2. agent_episodes — direction (a): reconcile against the TARGET's own forget_log (now
    //    up to date per step 1) before inserting anything. A row the bundle carries but the
    //    target's forget_log ALREADY NAMES — at any ts, no timestamp comparison — is skipped and
    //    reported, never written. See the module header for why a `ts >=` gate was wrong.
    for (const row of bundle.tables.agent_episodes) {
      const forgotten = edb
        .prepare("SELECT 1 FROM forget_log WHERE kind = 'episode' AND target = ? LIMIT 1")
        .get(row.id);
      if (forgotten) {
        stats.agent_episodes.skipped_forgotten++;
        continue;
      }
      const result = importDeduped(
        edb,
        "SELECT 1 FROM agent_episodes WHERE id = ? LIMIT 1",
        [row.id],
        `INSERT INTO agent_episodes (${AGENT_EPISODE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id,
          row.ts,
          row.vault_id,
          row.session_id,
          row.caller,
          row.channel,
          row.episode_type,
          row.tool,
          row.status,
          row.error_code,
          row.duration_ms,
          row.result_size,
          row.args_hash,
          row.args_json,
          row.secret_scan,
          row.summary,
          row.tags,
          row.task_result,
          row.eligibility,
          row.trust,
          row.blocked,
          row.valid_from,
          row.valid_until,
          row.prev_id,
          row.eligibility_reason,
          row.eligibility_policy,
          row.verdict_at,
        ],
        dryRun,
      );
      stats.agent_episodes[result]++;
    }

    // 3. Every other vault-scoped table — no cascade, no reconciliation, plain dedup-by-natural-key.
    // THE-891: preference_profile's natural key gained scope_caller, mirroring the PK it rebuilds
    // to (vault_id, scope_caller, key) — omitting it here would dedup two DIFFERENT callers'
    // partitions against each other under the old (vault_id, key) key, silently dropping one.
    for (const row of bundle.tables.preference_profile) {
      const result = importDeduped(
        edb,
        "SELECT 1 FROM preference_profile WHERE vault_id = ? AND scope_caller = ? AND key = ? LIMIT 1",
        [row.vault_id, row.scope_caller, row.key],
        `INSERT INTO preference_profile (${PREFERENCE_PROFILE_COLS}) VALUES (?,?,?,?,?,?,?,?)`,
        [
          row.vault_id,
          row.scope_caller,
          row.key,
          row.value,
          row.weight,
          row.version,
          row.updated_at,
          row.provenance,
        ],
        dryRun,
      );
      stats.preference_profile[result]++;
    }

    for (const row of bundle.tables.preference_deltas) {
      const result = importDeduped(
        edb,
        "SELECT 1 FROM preference_deltas WHERE vault_id = ? AND scope_caller = ? AND ts = ? AND key = ? AND op = ? AND version = ? LIMIT 1",
        [row.vault_id, row.scope_caller, row.ts, row.key, row.op, row.version],
        "INSERT INTO preference_deltas (ts, key, op, value, evidence, version, vault_id, scope_caller) VALUES (?,?,?,?,?,?,?,?)",
        [
          row.ts,
          row.key,
          row.op,
          row.value,
          row.evidence,
          row.version,
          row.vault_id,
          row.scope_caller,
        ],
        dryRun,
      );
      stats.preference_deltas[result]++;
    }

    for (const row of bundle.tables.note_quality) {
      const result = importDeduped(
        edb,
        "SELECT 1 FROM note_quality WHERE vault_id = ? AND path = ? LIMIT 1",
        [row.vault_id, row.path],
        `INSERT INTO note_quality (${NOTE_QUALITY_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.vault_id,
          row.path,
          row.computed_at,
          row.chunk_count,
          row.dup_chunk_count,
          row.dup_ratio,
          row.mtime,
          row.age_days,
          row.last_retrieved_at,
          row.retrievals,
          row.citations,
          row.in_degree,
          row.out_degree,
          row.orphan,
          row.contradictions_open,
          row.tombstoned,
          row.quality_score,
          row.score_version,
          row.flags,
          row.observed_retrievals,
        ],
        dryRun,
      );
      stats.note_quality[result]++;
    }

    for (const row of bundle.tables.gap_reports) {
      const result = importDeduped(
        edb,
        "SELECT 1 FROM gap_reports WHERE vault_id = ? AND computed_at = ? LIMIT 1",
        [row.vault_id, row.computed_at],
        "INSERT INTO gap_reports (vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items) VALUES (?,?,?,?,?,?,?,?)",
        [
          row.vault_id,
          row.computed_at,
          row.threshold,
          row.min_results,
          row.total,
          row.gaps,
          row.gap_rate,
          row.items,
        ],
        dryRun,
      );
      stats.gap_reports[result]++;
    }

    for (const row of bundle.tables.goals) {
      const result = importDeduped(
        edb,
        "SELECT 1 FROM goals WHERE id = ? LIMIT 1",
        [row.id],
        `INSERT INTO goals (${GOAL_COLS}) VALUES (?,?,?,?,?,?,?,?)`,
        [
          row.id,
          row.vault_id,
          row.text,
          row.status,
          row.source,
          row.created_at,
          row.target_date,
          row.closed_at,
        ],
        dryRun,
      );
      stats.goals[result]++;
    }

    // 4. Global tables (no vault axis at all). Both are keyed by a chunk id that is a HASH of the
    //    vault id string (chunkId(vaultId, path, index)) — two unrelated installs' same-named
    //    vaults produce identical ids for same-path notes (BLOCKER 2b, module header). Ground-
    //    truth each row against the TARGET's own `cache.db.chunks`: only a chunk id the target has
    //    actually indexed is trusted to belong to a vault this install has. `chunks` may not exist
    //    at all on a never-indexed target — `tableExists` guards that rather than throwing, and
    //    every row is honestly `skipped_unmatched` in that case (there is nothing to match yet).
    const chunksTableReady = tableExists(cacheDb, "chunks");
    const chunkExists = (chunkId: string): boolean =>
      chunksTableReady &&
      cacheDb.prepare("SELECT 1 FROM chunks WHERE id = ? LIMIT 1").get(chunkId) !== undefined;

    for (const row of bundle.tables.chunk_retrievals) {
      if (!chunkExists(row.chunk_id)) {
        stats.chunk_retrievals.skipped_unmatched++;
        continue;
      }
      const result = importDeduped(
        edb,
        "SELECT 1 FROM chunk_retrievals WHERE id = ? LIMIT 1",
        [row.id],
        `INSERT INTO chunk_retrievals (${CHUNK_RETRIEVAL_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id,
          row.chunk_id,
          row.retrieved_at,
          row.session_id,
          row.surface_type,
          row.query_text,
          row.rank_in_results,
          row.rerank_score,
          row.cited_in_response,
          row.citation_score,
          row.feedback,
          row.caller,
          row.event_group,
          row.stream_source,
          row.citation_state,
        ],
        dryRun,
      );
      stats.chunk_retrievals[result]++;
    }

    for (const row of bundle.tables.vault_object_state) {
      if (!chunkExists(row.object_id)) {
        stats.vault_object_state.skipped_unmatched++;
        continue;
      }
      const result = importDeduped(
        edb,
        "SELECT 1 FROM vault_object_state WHERE object_id = ? LIMIT 1",
        [row.object_id],
        `INSERT INTO vault_object_state (${VAULT_OBJECT_STATE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.object_id,
          row.retrieval_strength,
          row.storage_strength,
          row.frequency,
          row.last_accessed,
          row.learned_at,
          row.valid_from,
          row.valid_until,
          row.emotional_weight,
          row.confidence,
          row.injections,
          row.hits,
          row.misses,
          row.last_hit_at,
          row.cached_activation_score,
          row.last_computed_at,
        ],
        dryRun,
      );
      stats.vault_object_state[result]++;
    }
  };

  if (dryRun) {
    run();
  } else {
    edb.exec("BEGIN");
    try {
      run();
      edb.exec("COMMIT");
    } catch (e) {
      edb.exec("ROLLBACK");
      throw e;
    }
  }

  return { tables: stats, dry_run: dryRun };
}
