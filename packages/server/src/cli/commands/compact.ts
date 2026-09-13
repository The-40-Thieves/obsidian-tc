// THE-1039 (GH #930) — `obsidian-tc compact`: the operator compaction path 26 CLI verbs never had.
// `maintenance.ts`'s sweep deliberately never VACUUMs ("disruptive under WAL") and now runs only a
// BOUNDED FTS5 'merge' (THE-1039 item 1, GH #929) — this is the explicit, full-'optimize' path an
// operator reaches for on purpose.
//
// RULING (do not re-open): the default path VACUUMs cache.db/experiential.db IN PLACE and never
// swaps files — a rename over a database another process (a live server, another CLI invocation)
// holds open would strand that process on the old inode, which is worse than the space this
// command reclaims. `--into <dir>` is the copy path: it leaves the live file untouched and prints
// the exact `mv` for the operator to run once nothing else has the database open — this command
// never moves a file itself.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbFootprintBytes, FTS_TABLE_NAMES, tableExists } from "../../db/introspect";
import { openDatabase } from "../../db/open";
import { busyReason } from "../../db/txn";
import type { Database } from "../../db/types";
import { type Cmd, resolveOrUsageExit } from "../shared";

const COMPACTABLE_DBS = ["cache.db", "experiential.db"] as const;
type CompactableDb = (typeof COMPACTABLE_DBS)[number];

/** THE-1039 fix round 1 (A1, A4) — an EXPECTED, reportable failure for one database, as opposed
 *  to a bug. Caught per-database in `run_compact`'s loop and turned into a report row rather than
 *  aborting the whole command (see that function's comment for the incident this closes). Any
 *  error NOT an instance of this class is a bug and still propagates to crash the process. */
export class CompactError extends Error {}

/** Thrown when a VACUUM (in place or INTO) hits SQLITE_BUSY — another connection holds the
 *  database open past `db.busyTimeoutMs`. An operator needs "something else has this open", not a
 *  raw SQLite error code. */
export class CompactBusyError extends CompactError {
  constructor(readonly dbName: CompactableDb) {
    super(`${dbName} is busy — another connection holds it open`);
  }
}

/** THE-1039 fix round 1 (A4) — `--into <dir>` already containing this database's file name.
 *  Previously a bare `Error`, caught only by cli.ts's generic `fatal:` handler; now routed through
 *  the same plain-language, per-database reporting path as every other expected failure here. */
export class CompactDestinationExistsError extends CompactError {
  constructor(readonly destPath: string) {
    super(`${destPath} already exists — VACUUM INTO refuses to overwrite it`);
  }
}

/** One database's compaction (or dry-run inspection) result — dry-run/real and in-place/--into
 *  are all one type so `run_compact` prints and `--json`-serializes every shape through one path.
 *  Byte counts are the database's FOOTPRINT (main file + `-wal`, A2's `dbFootprintBytes` — same
 *  function doctor's `db.reclaimable-space` uses), except `freelistBytes`. */
export interface DbCompactReport {
  db: CompactableDb;
  path: string;
  dryRun: boolean;
  /** A1/A4: set when this database's operation failed outright (busy, or an `--into` collision).
   *  Every other field is a best-effort pre-failure snapshot; `integrityOk` is `false`, which
   *  drives the exit code the same way a verification failure does. */
  error?: string;
  beforeBytes: number;
  /** Equals `beforeBytes` under `--dry-run` (nothing changed) and, under `--into`, is the live
   *  file's footprint (still unchanged) — the copy's size is `into.copyBytes`. */
  afterBytes: number;
  reclaimedBytes: number;
  /** Tables `'optimize'` ran against. Empty under `--dry-run`, which never writes. */
  ftsOptimized: string[];
  integrityOk: boolean;
  integrityIssues: string[];
  /** `--dry-run` only: `freelist_count * page_size` — bytes a VACUUM would reclaim. */
  freelistBytes?: number;
  /** `--dry-run` only: each present FTS table's `<t>_data` row count. */
  ftsDataRows?: Record<string, number>;
  /** `--into` only. */
  into?: {
    path: string;
    copyBytes: number;
    mv: string;
    rowCountMismatches: string[];
    /** A5: when the `VACUUM INTO` snapshot was taken (ISO 8601) — the copy reflects the live
     *  database as of exactly this instant, whenever it is later installed. */
    snapshotAt: string;
  };
}

/** Single-quote a path for SQL — VACUUM INTO takes a string literal, not a bind parameter. Same
 *  idiom as workspace/rerun.ts's private `quoteSqlString` (stageDatabase's VACUUM INTO); not
 *  imported from there to keep this command's dependency surface to db/* only. */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Single-quote a path for a POSIX shell command line (the printed `mv`). */
function quoteShString(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The FTS5 integrity-check special command, generically over any table in FTS_TABLE_NAMES —
 *  fts.ts's `verifyNotesFtsIntegrity` is notes_fts-specific (it also runs the divergence repair);
 *  this command only ever needs the bare probe, and needs it for chunk_fts too. */
function ftsIntegrityCheck(db: Database, table: string): { ok: boolean; reason?: string } {
  try {
    db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Every table name in `db` worth comparing for the `--into` row-count check: every real table,
 * MINUS the sqlite-internal ones and MINUS each FTS table's own shadow tables (`<t>_data`,
 * `<t>_idx`, `<t>_content`, `<t>_docsize`, `<t>_config`).
 *
 * The shadow tables are EXPECTED to disagree after `optimizeFtsTables` runs on the copy — that is
 * the entire point of `'optimize'`, merging b-tree segments changes how many rows `<t>_data`/
 * `<t>_idx` hold without changing a single indexed document. Comparing them here would turn the
 * command's own step (a) into a permanent verification failure. The FTS virtual table itself
 * (`notes_fts`, `chunk_fts`) is NOT excluded — its row count is the logical document count, which
 * `'optimize'` must never change, so that comparison stays meaningful.
 */
function realTableNames(db: Database): string[] {
  const shadowPrefixes = FTS_TABLE_NAMES.map((t) => `${t}_`);
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !shadowPrefixes.some((p) => n.startsWith(p)));
}

/** Row count per table in `tables`. -1 marks a table that failed to count (surfaces as a mismatch
 *  below, rather than silently vanishing from the comparison). */
function tableRowCounts(db: Database, tables: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    } catch {
      out[t] = -1;
    }
  }
  return out;
}

/**
 * Compare every table's row count between the live database and its `VACUUM INTO` copy.
 *
 * Best-effort, not a strict proof: the live database can still be written to (WAL mode, a running
 * server) between the moment `VACUUM INTO` took its consistent snapshot and this comparison
 * running, so a mismatch on an actively-written table is not necessarily corruption — it is
 * reported as a mismatch either way, since a compaction command has no way to tell "expected drift
 * from concurrent writes" from "the copy is short a table's worth of rows" and must not guess.
 */
function verifyRowCounts(live: Database, copy: Database): string[] {
  const tables = realTableNames(live);
  const liveCounts = tableRowCounts(live, tables);
  const copyCounts = tableRowCounts(copy, tables);
  return tables
    .filter((t) => liveCounts[t] !== copyCounts[t])
    .map((t) => `${t}: live=${liveCounts[t]} copy=${copyCounts[t]}`);
}

async function dryRunOneDatabase(
  name: CompactableDb,
  path: string,
  busyTimeoutMs: number,
): Promise<DbCompactReport> {
  const beforeBytes = dbFootprintBytes(path);
  // THE-1039 fix round 1 (F2): `--dry-run` only ever READS — opened `readonly: true` so it cannot
  // trip `journal_mode = WAL` (or any other write pragma) as a side effect of inspecting a
  // still-DELETE-mode database. See db/pragmas.ts's `readonlyConnectionPragmas`.
  const db = await openDatabase(path, busyTimeoutMs, { readonly: true });
  try {
    const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const freelistCount = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number })
      .freelist_count;
    const ftsDataRows: Record<string, number> = {};
    for (const t of FTS_TABLE_NAMES) {
      if (tableExists(db, t)) {
        ftsDataRows[t] = (
          db.prepare(`SELECT COUNT(*) AS n FROM "${t}_data"`).get() as {
            n: number;
          }
        ).n;
      }
    }
    return {
      db: name,
      path,
      dryRun: true,
      beforeBytes,
      afterBytes: beforeBytes,
      reclaimedBytes: 0,
      ftsOptimized: [],
      integrityOk: true,
      integrityIssues: [],
      freelistBytes: freelistCount * pageSize,
      ftsDataRows,
    };
  } finally {
    db.close?.();
  }
}

/** Run FTS5 `'optimize'` on every present FTS table on `db` — step a. In the in-place path `db`
 *  is the live connection; under `--into` it is the freshly `VACUUM INTO`-ed copy instead (see
 *  `compactOneDatabase`'s `--into` branch for why: the live file must never be written to). */
function optimizeFtsTables(db: Database): string[] {
  const optimized: string[] = [];
  for (const t of FTS_TABLE_NAMES) {
    if (tableExists(db, t)) {
      db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
      optimized.push(t);
    }
  }
  return optimized;
}

/** Step c: `PRAGMA integrity_check` plus the FTS integrity-check insert on each present FTS table,
 *  against whichever connection (`live` after an in-place VACUUM, or the opened copy under
 *  `--into`) is passed in. */
function verifyIntegrity(db: Database): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const check = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
    .integrity_check;
  if (check !== "ok") issues.push(`PRAGMA integrity_check: ${check}`);
  for (const t of FTS_TABLE_NAMES) {
    if (tableExists(db, t)) {
      const r = ftsIntegrityCheck(db, t);
      if (!r.ok) issues.push(`${t} integrity-check: ${r.reason}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** THE-1039 fix round 1 (F3) — `VACUUM`'s freed pages can sit entirely in the WAL until
 *  checkpointed: measured directly, a 1.2 MB `-wal` file held everything a VACUUM had just freed
 *  while the main file stayed at its PRE-VACUUM size, so `statSync` immediately after `VACUUM`
 *  (and before the connection closed) reported zero bytes reclaimed on a WAL database. `TRUNCATE`
 *  checkpoints every WAL frame into the main file AND truncates the `-wal` file itself back to
 *  empty, so a footprint measurement taken right after this call is accurate without needing to
 *  close (and reopen) the connection first. */
function checkpointTruncate(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

async function compactOneDatabase(
  name: CompactableDb,
  path: string,
  busyTimeoutMs: number,
  intoDir: string | undefined,
): Promise<DbCompactReport> {
  const beforeBytes = dbFootprintBytes(path);
  // F2: under `--into`, `db` only ever runs `VACUUM INTO` — a read of the source per
  // sqlite.org/lang_vacuum.html ("the original database file is unchanged"), confirmed directly
  // against node:sqlite/better-sqlite3 — plus the read-only row-count comparison after, so
  // `readonly: true` never applies `journal_mode = WAL` to a database still in DELETE mode. The
  // in-place path needs a WRITABLE connection (it runs VACUUM itself), so only `--into` gets it.
  const db = await openDatabase(path, busyTimeoutMs, { readonly: intoDir !== undefined });
  try {
    if (intoDir !== undefined) {
      // `db` is NEVER written to here — 'optimize' and the reclaiming VACUUM both run against the
      // COPY once it exists, which is what keeps the live file byte-for-byte untouched.
      mkdirSync(intoDir, { recursive: true });
      const destPath = join(intoDir, name);
      if (existsSync(destPath)) throw new CompactDestinationExistsError(destPath);

      let copyDb: Database | undefined;
      let ftsOptimized: string[];
      let integrity: { ok: boolean; issues: string[] };
      let rowCountMismatches: string[];
      let snapshotAt: string;
      try {
        db.exec(`VACUUM INTO ${quoteSqlString(destPath)}`);
        snapshotAt = new Date().toISOString(); // THE-1039 fix round 1 (A5)
        copyDb = await openDatabase(destPath, busyTimeoutMs);
        ftsOptimized = optimizeFtsTables(copyDb);
        copyDb.exec("VACUUM");
        checkpointTruncate(copyDb);
        integrity = verifyIntegrity(copyDb);
        rowCountMismatches = verifyRowCounts(db, copyDb);
      } catch (e) {
        if (busyReason(e)) throw new CompactBusyError(name);
        throw e;
      } finally {
        copyDb?.close?.();
      }
      // F1: `into` is populated either way (the copy stays on disk regardless), but printReport
      // only recommends installing it when `ok` — never after a failed verification.
      const ok = integrity.ok && rowCountMismatches.length === 0;
      const copyBytes = dbFootprintBytes(destPath);
      return {
        db: name,
        path,
        dryRun: false,
        beforeBytes,
        afterBytes: beforeBytes, // the LIVE file — untouched by --into
        reclaimedBytes: beforeBytes - copyBytes,
        ftsOptimized,
        integrityOk: ok,
        integrityIssues: [
          ...integrity.issues,
          ...rowCountMismatches.map((m) => `row-count mismatch: ${m}`),
        ],
        into: {
          path: destPath,
          copyBytes,
          mv: `mv ${quoteShString(destPath)} ${quoteShString(path)}`,
          rowCountMismatches,
          snapshotAt,
        },
      };
    }

    let ftsOptimized: string[];
    try {
      ftsOptimized = optimizeFtsTables(db);
      db.exec("VACUUM");
      checkpointTruncate(db); // THE-1039 fix round 1 (F3) — see that function's own comment
    } catch (e) {
      if (busyReason(e)) throw new CompactBusyError(name);
      throw e;
    }
    const integrity = verifyIntegrity(db);
    const afterBytes = dbFootprintBytes(path);
    return {
      db: name,
      path,
      dryRun: false,
      beforeBytes,
      afterBytes,
      reclaimedBytes: beforeBytes - afterBytes,
      ftsOptimized,
      integrityOk: integrity.ok,
      integrityIssues: integrity.issues,
    };
  } finally {
    db.close?.();
  }
}

function printReport(r: DbCompactReport): void {
  if (r.error !== undefined) {
    process.stderr.write(`${r.db}: ${r.error}\n`);
    return;
  }
  if (r.dryRun) {
    process.stdout.write(
      `${r.db}: ${r.beforeBytes} bytes on disk (main + -wal), ${r.freelistBytes ?? 0} bytes reclaimable by VACUUM (freelist)\n`,
    );
    for (const [t, n] of Object.entries(r.ftsDataRows ?? {})) {
      process.stdout.write(`  ${t}_data: ${n} rows\n`);
    }
    return;
  }
  const tail = r.ftsOptimized.length > 0 ? `, optimized ${r.ftsOptimized.join(", ")}` : "";
  if (r.into) {
    process.stdout.write(
      `${r.db}: live ${r.beforeBytes} bytes, copy ${r.into.copyBytes} bytes (${r.reclaimedBytes} reclaimable, main + -wal)${tail}\n`,
    );
    if (r.integrityOk) {
      // THE-1039 fix round 1 (F1): only reached when verification passed.
      process.stdout.write(`  verified copy at ${r.into.path}\n`);
      process.stdout.write(`  to install it: ${r.into.mv}\n`);
      // THE-1039 fix round 1 (A5): the copy is a point-in-time snapshot, not a live mirror.
      process.stdout.write(
        `  snapshot taken ${r.into.snapshotAt} — reflects ${r.db} as of that instant only. If ` +
          `anything (the server included) wrote to ${r.db} after that moment, those writes are ` +
          "NOT in this copy. STOP the server (and anything else that writes to it) before " +
          "installing this copy with the mv above; if it was still running while this ran, " +
          "run `compact --into` again after stopping it.\n",
      );
    } else {
      // THE-1039 fix round 1 (F1): the copy FAILED verification — left in place for inspection,
      // and explicitly NOT recommended for installation.
      process.stdout.write(
        `  copy FAILED verification — left at ${r.into.path} for inspection; DO NOT install it\n`,
      );
      for (const issue of r.integrityIssues) process.stderr.write(`  ! ${issue}\n`);
    }
    return;
  }
  process.stdout.write(
    `${r.db}: ${r.beforeBytes} -> ${r.afterBytes} bytes (${r.reclaimedBytes} reclaimed, main + -wal)${tail}\n`,
  );
  if (!r.integrityOk) {
    for (const issue of r.integrityIssues) process.stderr.write(`  ! ${issue}\n`);
  }
}

/** A1/A4: the failure report row for a per-database failure, so the loop below can record it and
 *  move on. Takes `unknown`, not just `CompactError`: cli.ts's own `fatal:` handler only ever
 *  printed `(err as Error).message` too (no stack trace either way), so wrapping ANY error here
 *  loses nothing an operator would have seen while still letting the OTHER database compact. */
function errorReport(
  name: CompactableDb,
  path: string,
  dryRun: boolean,
  e: unknown,
): DbCompactReport {
  const message = e instanceof Error ? e.message : String(e);
  return {
    db: name,
    path,
    dryRun,
    error: message,
    beforeBytes: existsSync(path) ? dbFootprintBytes(path) : 0,
    afterBytes: existsSync(path) ? dbFootprintBytes(path) : 0,
    reclaimedBytes: 0,
    ftsOptimized: [],
    integrityOk: false,
    integrityIssues: [message],
  };
}

/**
 * `obsidian-tc compact` — see the file header for the ruling on in-place VACUUM vs `--into`.
 * Runs cache.db then experiential.db, in order, skipping either that does not exist.
 *
 * A1 incident this closes: a `SQLITE_BUSY` on the SECOND database used to `process.exit(1)` from
 * inside the loop before the report/`--json` for an already-succeeded FIRST database ever ran, so
 * that success was reported nowhere. Every outcome — success, or ANY failure (a classified
 * `CompactError`, or an unexpected one — see `errorReport`'s comment for why widening the catch
 * that far loses no information a crash would have shown) — is now collected into `reports` first;
 * the report/`--json` are always emitted, and the exit code goes non-zero if ANY database failed or
 * failed verification, decided once at the end.
 */
export async function run_compact(cmd: Cmd<"compact">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  const busyTimeoutMs = cfg.db.busyTimeoutMs;
  const dryRun = cmd.dryRun === true;
  const reports: DbCompactReport[] = [];

  for (const name of COMPACTABLE_DBS) {
    const path = join(cfg.cacheDir, name);
    if (!existsSync(path)) continue;
    try {
      const report = dryRun
        ? await dryRunOneDatabase(name, path, busyTimeoutMs)
        : await compactOneDatabase(name, path, busyTimeoutMs, cmd.into);
      reports.push(report);
    } catch (e) {
      reports.push(errorReport(name, path, dryRun, e)); // any failure, classified or not
    }
  }

  if (reports.length === 0) {
    process.stdout.write("compact: no cache.db or experiential.db found — nothing to compact\n");
    return;
  }

  for (const r of reports) printReport(r);
  if (!dryRun && cmd.into === undefined && reports.some((r) => r.error === undefined)) {
    process.stdout.write(
      "note: VACUUM needs roughly as much free disk space as the database's own current size " +
        "(it writes a full replacement before the original is freed) — about 2x headroom overall.\n",
    );
  }

  if (cmd.json !== undefined) {
    writeFileSync(cmd.json, JSON.stringify(reports, null, 2));
    process.stdout.write(`wrote ${cmd.json}\n`);
  }

  if (reports.some((r) => !r.integrityOk)) process.exit(1);
}
