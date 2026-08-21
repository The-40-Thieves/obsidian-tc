// THE-636 — context portability: export/import the derived plane (experiential.db) as a
// vendor-neutral bundle. CLI-only (cli/commands/context-export.ts, context-import.ts) — see the
// verified design note for why this is a CLI command and not a new MCP tool: the MCP surface is
// itself the exfiltration/attack surface item 2 of the ticket warns about, and this repo already
// has an established precedent (forget.ts) for admin/operator-only, filesystem-touching commands
// that read or write the experiential store directly, outside `registry.dispatch`.
//
// TWO DIRECTIONS OF "FORGET WINS OVER IMPORT" (ticket item 3, THE-239/THE-605/THE-609's audit
// story):
//
//   (a) IMPORTED-FORGOTTEN STAYS FORGOTTEN. `agent_episodes` rows are only ever exported with
//       `blocked = 0` (see context-bundle-schema.ts's row schema, which hard-pins `blocked:
//       z.literal(0)`) — a tombstoned episode never leaves the source install in the first place.
//       The harder case is the RECEIVING install: it may have forgotten an episode the bundle
//       still carries as live, because a DIFFERENT install forgot it independently — at ANY time,
//       before or after the bundle's `exported_at`. `importContextBundle` reconciles against the
//       TARGET's own forget_log before inserting any `agent_episodes` row — never against the
//       bundle's — and the check is EXISTENCE ONLY, with no timestamp comparison: an earlier
//       version gated on `forget_log.ts >= bundle.exported_at`, reasoning "only a forget that
//       happened after this bundle was made can be resurrecting something new". That reasoning is
//       wrong across machines with independent clocks and independent forget histories — the
//       primary migration case is a bundle exported NOW from install A, carrying an episode that
//       install B (the target) forgot LONG AGO (ts < exported_at). Under the timestamp-gated
//       check that forget is invisible (its ts is always < exported_at) and the episode gets
//       re-written, unblocked, resurrecting exactly what B tombstoned. Wall-clock comparison
//       across machines is not a safety primitive here: if the target's forget_log names a target
//       id AT ALL, that id is never resurrected by import — full stop, regardless of when.
//   (b) IMPORTED forget_log ENTRIES APPLY TO TARGET CONTENT. A forget_log entry is audit history,
//       not inert metadata — importing one must have the same real effect appending it locally
//       would have. So forget_log rows import FIRST (before agent_episodes), and each new
//       'episode'-kind entry immediately blocks (and, for 'erase', scrubs) any MATCHING episode
//       already in the target — whether that episode is native to the target or arrived via a
//       DIFFERENT, earlier import. A forget event travelling in the bundle must be able to
//       retroactively forget content the bundle itself never carried.
//
// IDEMPOTENCY: every table dedups on a NATURAL KEY before writing (never a bare "run it twice and
// hope autoincrement doesn't collide") — see the header note on `importDeduped`. Re-importing the
// same bundle a second time writes nothing new anywhere.
//
// CROSS-INSTALL VAULT IDENTITY (THE-636 review fix, BLOCKER 2): a vault id is a bare operator
// label ("main" everywhere) with no cross-install identity, and `vault_object_state.object_id` /
// `chunk_retrievals.chunk_id` are `chunkId(vaultId, path, index)` — a hash of that SAME label, not
// of anything globally unique. Two unrelated installs each running a vault called "main" produce
// IDENTICAL chunk ids for same-path notes. Importing verbatim would silently merge two unrelated
// vaults' derived state under a shared label. Two mechanisms close this:
//   - `remapBundleVault` makes `--vault` LOAD-BEARING: when the operator names a target vault, every
//     vault-SCOPED row (the 6 tables that carry `vault_id`) is remapped from the bundle's actual
//     source vault to that target, and a bundle whose vault-scoped rows name more than one source
//     vault is refused outright — "the" source vault would be undefined. Omitting `--vault` keeps
//     rows verbatim, which is the OTHER legitimate case this ticket names: migrating a whole
//     deployment to a new machine, where source and target are the SAME logical vault under the
//     SAME id, not two vaults merging.
//   - `chunk_retrievals`/`vault_object_state` have NO `vault_id` column at all, so there is nothing
//     to remap. Instead, `importContextBundle` verifies each row's chunk id GROUND-TRUTH against the
//     TARGET's own `cache.db` `chunks` table: a row whose id the target has never indexed is not
//     imported (`skipped_unmatched`), because there is no local evidence it belongs to a vault this
//     install actually has. This is best-effort and index-dependent — importing before the target
//     vault has been indexed matches nothing; re-running the import after `index_vault`/`obsidian-tc
//     index` picks up what an earlier pass skipped (idempotent dedup means a re-run costs nothing).
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
  /** Narrow the 6 vault-scoped-and-filterable tables to one vault. `chunk_retrievals`,
   *  `vault_object_state` and `forget_log` are ALWAYS exported in full regardless — see
   *  `ALWAYS_FULL_TABLES`'s doc comment for why. Absent -> deployment-wide export, `vault: "*"`. */
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
 *  THE-891: `preference_profile`/`preference_deltas` now carry `scope_caller`, so a bundle exports
 *  learned state that CROSSES caller partitions within the vault(s) it covers — a human-scoped row
 *  alongside every caller-scoped one, unfiltered. That is intentional here, not an oversight this
 *  ticket left open: this module is the same admin/operator-only, CLI-only, `registry.dispatch`-
 *  bypassing surface the module header already establishes (mirroring `forget.ts`'s precedent) —
 *  reachable only by an operator running `obsidian-tc context-export` directly on the box, never
 *  through the MCP tool surface partition-scoped reads (`preferenceProfile`'s own `admin:workspace`
 *  gate) protect against. The existing CLI-command elevation already covers a cross-caller export;
 *  it does not need — and deliberately does not get — a second, redundant scope check here. */
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
  // deliberate choice not to guess one from `target` (forget_log). See ALWAYS_FULL_TABLES.
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
