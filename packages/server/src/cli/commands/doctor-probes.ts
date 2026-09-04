// THE-935 fix round 3: extracted verbatim out of cli/commands/doctor.ts, which crossed biome's
// noExcessiveLinesPerFile ceiling (700 logical lines) once THE-939's new doctor check registration
// landed on main alongside this ticket's busyTimeoutMs parameter threading. Split, not squeezed:
// these five `doctor --probe` checks are self-contained (cacheDir + busyTimeoutMs in, a typed
// result out) and share nothing with the rest of doctor.ts beyond that shape, so they move here
// with named exports and doctor.ts imports them. No behaviour change and no signature change
// beyond the move — see db-busy-timeout-inventory.test.ts, which still scans this file (it globs
// packages/server/src/**/*.ts) and is unaffected by which file a compliant call site lives in.
//
// Three of the five doc comments were reattached to the function they actually describe while
// moving: probeDerivedTables', probeDerivedColumns' and probeKbHealth's JSDoc blocks had drifted
// to sit consecutively above probeKbHealth alone (probeDerivedTables/probeDerivedColumns follow
// it in the file, so their descriptions ended up stacked above a function neither describes) —
// a pre-existing drift from an earlier reordering, not something this move introduced, fixed as a
// side effect of relocating each block with its function instead of copying whatever text was
// textually adjacent.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../db/open";
import type {
  DerivedColumnState,
  DerivedTableState,
  EntryPointsProbe,
  KbHealthProbe,
} from "../../doctor";
import { experientialColumnSpec } from "../../doctor/column-spec";
import { experientialTableSpec } from "../../doctor/table-spec";
import { ensureNotesFts, type NotesFtsIntegrity, verifyNotesFtsIntegrity } from "../../search/fts";

/**
 * THE-696 — the opt-in notes_fts integrity probe behind `doctor --probe`. Opens cache.db
 * READ-WRITE — FTS5 exposes integrity-check as an INSERT into the virtual table, so a read-only
 * handle cannot run it; WAL mode keeps this safe alongside a running server. Checks
 * `ensureNotesFts` first: availability ("off") and soundness ("malformed") are different
 * questions. Never throws. See docs/design/cli-doctor.md.
 */
export async function probeNotesFts(
  cacheDir: string,
  busyTimeoutMs: number, // THE-935: required — see openConfiguredDatabase in db/open.ts
): Promise<{ ftsEnabled: boolean; integrity?: NotesFtsIntegrity }> {
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(join(cacheDir, "cache.db"), busyTimeoutMs);
    const ftsEnabled = ensureNotesFts(db);
    if (!ftsEnabled) return { ftsEnabled: false };
    return { ftsEnabled: true, integrity: verifyNotesFtsIntegrity(db) };
  } catch {
    // No cache.db yet (fresh install), or it cannot be opened. Either way there is no index to
    // pronounce on — fall back to the unprobed wording rather than inventing a verdict.
    return { ftsEnabled: process.env.OBSIDIAN_TC_DISABLE_FTS !== "1" };
  } finally {
    try {
      // `close` is OPTIONAL on the Database interface — the node:sqlite adapter used in tests and
      // in the .mcpb bundle does not expose it. Optional-call, not a bare `db?.close()`.
      db?.close?.();
    } catch {
      /* closing a handle we may never have opened must not fail the run */
    }
  }
}

/**
 * Count rows in the derived tables and classify each one's writer, for `derived.liveness`. The
 * classification is load-bearing: a row count alone can't distinguish "switched off" from "on and
 * never worked" — only the second is a finding. `writer: "none"` means no code path writes the
 * table at all, distinct from "disabled". See `table-spec.ts` for the current classification per
 * table (THE-629 corrected an earlier misclassification here — docs/design/cli-doctor.md). Never
 * throws: a missing store degrades to an empty list, not a wall of false warnings.
 */
export async function probeDerivedTables(
  cacheDir: string,
  busyTimeoutMs: number,
  cfg: {
    /** True when the configured embeddings provider emits embedFull (the sparse/ColBERT heads). */
    multiVector: boolean;
    /** True when any experiential gate is on — the same three the server uses. */
    experiential: boolean;
    /** True when an ACL block is declared at the root or on any vault. The path-set cache is only
     *  ever built for a caller whose ACL actually filters something. */
    aclConfigured: boolean;
    /** True when destructive note writes capture an undo (config.snapshots.enabled). */
    snapshots: boolean;
    /** True when the coverage-gap sweep is SCHEDULED, not merely when the store is open. */
    gapSweepScheduled: boolean;
  },
): Promise<DerivedTableState[]> {
  const out: DerivedTableState[] = [];
  const count = (db: Awaited<ReturnType<typeof openDatabase>>, table: string): number | null => {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
      return r.c;
    } catch {
      return null; // table absent — runtime-provisioned and never created, same as zero rows
    }
  };

  const cachePath = join(cacheDir, "cache.db");
  if (existsSync(cachePath)) {
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      db = await openDatabase(cachePath, busyTimeoutMs);
      const multiVectorLever = "an embeddings provider emitting embedFull (bge-m3 / model-tier)";
      const spec: Array<[string, DerivedTableState["writer"], string]> = [
        // Both heads come from the SAME gate: embedFull exists only on providers that emit it, so
        // a dense-only provider darkens both at once. One config line, two dark tables.
        ["chunk_sparse", cfg.multiVector ? "enabled" : "disabled", multiVectorLever],
        ["chunk_colbert", cfg.multiVector ? "enabled" : "disabled", multiVectorLever],
        // memory_entities/memory_relations report `on-demand`, not `none` — a client calling
        // create_entity/link_entities is a valid, if rare, writer (THE-629). See
        // docs/design/cli-doctor.md.
        ["memory_entities", "on-demand", "a client calling create_entity (THE-629)"],
        ["memory_relations", "on-demand", "a client calling link_entities (THE-629)"],
        // Client- and user-driven surface: enabled means the verb is registered and reachable;
        // empty means it has never been exercised. THE-726: `sessions.autoOpen` also lets the
        // server open one itself on a principal's first dispatch — still on-demand, off by
        // default. See docs/design/cli-doctor.md.
        [
          "workspace_sessions",
          "on-demand",
          "a client calling start_session, or the server itself under sessions.autoOpen (THE-726)",
        ],
        ["capture_queue", "on-demand", "a client calling the capture verb"],
        [
          "note_snapshots",
          cfg.snapshots ? "on-demand" : "disabled",
          "a destructive note write while snapshots.enabled (restore_note has nothing to restore until then)",
        ],
        [
          "snapshot_blobs",
          cfg.snapshots ? "on-demand" : "disabled",
          "a destructive note write while snapshots.enabled",
        ],
        // Built per-caller only when an ACL actually filters something.
        [
          "acl_path_sets",
          cfg.aclConfigured ? "enabled" : "disabled",
          "an `acl` block at the root or on a vault",
        ],
        [
          "acl_path_members",
          cfg.aclConfigured ? "enabled" : "disabled",
          "an `acl` block at the root or on a vault",
        ],
        // plane.ts's recordRun writes this unconditionally when the table exists, and plane-wiring
        // imports wrapPlaneJob — so an empty table here is worth surfacing, not assuming.
        ["job_runs", "enabled", "plane jobs recording their runs via wrapPlaneJob"],
        // Derived planes that ARE writing today — included so `live` is non-empty and the check can
        // demonstrate it distinguishes success from silence, not just report problems.
        ["contradictions", "enabled", "the contradiction plane job"],
        ["syntheses", "enabled", "the weekly synthesis plane job"],
        ["vault_edges", "enabled", "the indexer deriving links from notes"],
      ];
      for (const [table, writer, lever] of spec) {
        const c = count(db, table);
        out.push({ table, rows: c ?? 0, writer, lever });
      }
    } catch {
      /* leave what we have */
    } finally {
      try {
        db?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }

  const expPath = join(cacheDir, "experiential.db");
  if (existsSync(expPath)) {
    let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      edb = await openDatabase(expPath, busyTimeoutMs);
      // The SET lives in doctor/table-spec.ts so it can be asserted independently of the probe
      // that consumes it — same separation, and same floor argument, as column-spec.ts.
      const spec = experientialTableSpec(cfg);
      for (const { table, writer, lever } of spec) {
        const c = count(edb, table);
        out.push({ table: `experiential.${table}`, rows: c ?? 0, writer, lever });
      }
    } catch {
      /* leave what we have */
    } finally {
      try {
        edb?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }
  return out;
}

/**
 * Sample the signal-bearing columns for `derived.column-liveness` (THE-720): total rows, non-NULL
 * rows, distinct non-NULL values, one aggregate per column. Re-read per column rather than cached
 * per table — a missing column must degrade to "skip this entry", not "table has no rows" (which
 * would mark every OTHER column on that table inconclusive too). Never throws, same contract as
 * probeDerivedTables. See docs/design/cli-doctor.md.
 */
export async function probeDerivedColumns(
  cacheDir: string,
  busyTimeoutMs: number,
  cfg: { experiential: boolean },
): Promise<DerivedColumnState[]> {
  const out: DerivedColumnState[] = [];
  const expPath = join(cacheDir, "experiential.db");
  if (!existsSync(expPath)) return out;
  let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    edb = await openDatabase(expPath, busyTimeoutMs);
    for (const s of experientialColumnSpec(cfg)) {
      try {
        const r = edb
          .prepare(
            `SELECT COUNT(*) AS rows, COUNT("${s.column}") AS nn,
                    COUNT(DISTINCT "${s.column}") AS d FROM "${s.table}"`,
          )
          .get() as { rows: number; nn: number; d: number };
        out.push({
          column: `experiential.${s.table}.${s.column}`,
          rows: r.rows,
          nonNull: r.nn,
          distinct: r.d,
          writer: s.writer,
          lever: s.lever,
        });
      } catch {
        // Table or column absent — a store predating the migration that added it. Dropping the
        // entry is right: reporting a column that does not exist as "never written" is a finding
        // about the schema, which the migration chain already owns.
      }
    }
  } catch {
    /* leave what we have */
  } finally {
    try {
      edb?.close?.();
    } catch {
      /* see probeNotesFts */
    }
  }
  return out;
}

/**
 * Read the newest kb_health report for `audit.kbHealth` (THE-722) — the reader `audit_reports`
 * never had; see docs/design/cli-doctor.md. Reads only, and never throws: a missing table (a store
 * predating the plane migration) degrades to `undefined`, rendered as "never run".
 */
export async function probeKbHealth(
  cacheDir: string,
  busyTimeoutMs: number,
): Promise<KbHealthProbe | undefined> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return undefined;
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs);
    const agg = db
      .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM audit_reports")
      .get() as { n: number; latest: number | null } | undefined;
    if (!agg || agg.n === 0) {
      return {
        totalReports: 0,
        now: Date.now(),
        hasIssues: false,
        summary: "",
        nullEmbeddings: 0,
        duplicateChunkPositions: 0,
        perVault: [],
      };
    }
    const row = db
      .prepare(
        "SELECT created_at, has_issues, summary, report FROM audit_reports ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { created_at: number; has_issues: number; summary: string; report: string };
    // The JSON column is the job's own AuditReport. Parsed defensively: a malformed row must not
    // take doctor down, and the counts degrade to 0 rather than to a false alarm.
    let parsed: {
      vault_null_embeddings?: number;
      duplicate_chunk_positions?: number;
      per_vault?: unknown;
    } = {};
    try {
      parsed = JSON.parse(row.report ?? "{}");
    } catch {
      /* keep the empty shape */
    }
    return {
      totalReports: agg.n,
      latestAt: row.created_at,
      now: Date.now(),
      hasIssues: row.has_issues === 1,
      summary: row.summary ?? "",
      nullEmbeddings: Number(parsed.vault_null_embeddings ?? 0),
      duplicateChunkPositions: Number(parsed.duplicate_chunk_positions ?? 0),
      perVault: Array.isArray(parsed.per_vault)
        ? (parsed.per_vault as KbHealthProbe["perVault"])
        : [],
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close?.();
    } catch {
      /* see probeNotesFts */
    }
  }
}

/**
 * Read the scheduler's own durable state and the tool-invocation census, for
 * `entrypoints.liveness` — both already written by the running server, so this reads truth rather
 * than deriving it. Filters `job_schedule` on `name IS NOT NULL`: SQLite does not enforce NOT NULL
 * on a TEXT PRIMARY KEY, so a null-named UPSERT inserts instead of updating (THE-715). The tool
 * census is a LOWER BOUND — `null` means NOT MEASURED, never coerced to 0. Never throws. See
 * docs/design/cli-doctor.md.
 */
export async function probeEntryPoints(
  cacheDir: string,
  busyTimeoutMs: number,
): Promise<EntryPointsProbe> {
  const out: EntryPointsProbe = { passes: [], tools: null, orphanScheduleRows: 0 };

  const cachePath = join(cacheDir, "cache.db");
  if (existsSync(cachePath)) {
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      db = await openDatabase(cachePath, busyTimeoutMs);
      const rows = db
        .prepare(
          "SELECT name, last_run_at, last_success_at, consecutive_failures FROM job_schedule WHERE name IS NOT NULL ORDER BY name",
        )
        .all() as Array<{
        name: string;
        last_run_at: number | null;
        last_success_at: number | null;
        consecutive_failures: number;
      }>;
      out.passes = rows.map((r) => ({
        name: r.name,
        lastRunAt: r.last_run_at,
        lastSuccessAt: r.last_success_at,
        consecutiveFailures: r.consecutive_failures,
      }));
      const orphans = db
        .prepare("SELECT COUNT(*) AS c FROM job_schedule WHERE name IS NULL")
        .get() as { c: number };
      out.orphanScheduleRows = orphans.c;
      // THE-716: run HISTORY, in its own try so a store without job_runs still reports the
      // schedule state above. `runs` stays null when the table is absent — not measured and
      // measured-zero are different facts, and the check renders them differently.
      try {
        const agg = db
          .prepare(
            "SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, " +
              "COUNT(DISTINCT job) AS jobs, MIN(started_at) AS oldest, MAX(started_at) AS newest FROM job_runs",
          )
          .get() as {
          n: number;
          failed: number | null;
          jobs: number;
          oldest: number | null;
          newest: number | null;
        };
        const names = db.prepare("SELECT DISTINCT job FROM job_runs ORDER BY job").all() as {
          job: string;
        }[];
        out.runs = {
          totalRuns: agg.n,
          failures: agg.failed ?? 0,
          jobs: names.map((r) => r.job),
          oldestAt: agg.oldest,
          newestAt: agg.newest,
        };
      } catch {
        /* no job_runs table — leave `runs` unset (not measured) */
      }
    } catch {
      /* table absent on a pre-scheduler db — leave the empty list */
    } finally {
      try {
        db?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }

  const expPath = join(cacheDir, "experiential.db");
  if (existsSync(expPath)) {
    let edb: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      edb = await openDatabase(expPath, busyTimeoutMs);
      const c = edb
        .prepare(
          "SELECT COUNT(DISTINCT tool) AS d, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM agent_episodes",
        )
        .get() as { d: number; n: number; lo: number | null; hi: number | null };
      out.tools = { distinctTools: c.d, episodes: c.n, firstAt: c.lo, lastAt: c.hi };
    } catch {
      /* no agent_episodes — stays null, i.e. NOT MEASURED, never 0 */
    } finally {
      try {
        edb?.close?.();
      } catch {
        /* see probeNotesFts */
      }
    }
  }
  return out;
}
