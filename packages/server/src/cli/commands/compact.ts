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
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FTS_TABLE_NAMES, tableExists } from "../../db/introspect";
import { openDatabase } from "../../db/open";
import { busyReason } from "../../db/txn";
import type { Database } from "../../db/types";
import { type Cmd, resolveOrUsageExit } from "../shared";

const COMPACTABLE_DBS = ["cache.db", "experiential.db"] as const;
type CompactableDb = (typeof COMPACTABLE_DBS)[number];

/** Thrown when a VACUUM (in place or INTO) hits SQLITE_BUSY — another connection holds the
 *  database open past `db.busyTimeoutMs`. Caught at the top of `run_compact`, never left to print
 *  a raw stack trace: an operator needs "something else has this open", not a SQLite error code. */
export class CompactBusyError extends Error {
  constructor(readonly dbName: CompactableDb) {
    super(`${dbName} is busy — another connection holds it open`);
  }
}

/** One database's compaction (or dry-run inspection) result. Fields are optional along the
 *  dry-run/real and in-place/--into axes rather than two separate types, so `run_compact` prints
 *  and `--json`-serializes both shapes through one path. */
export interface DbCompactReport {
  db: CompactableDb;
  path: string;
  dryRun: boolean;
  beforeBytes: number;
  /** Equals `beforeBytes` under `--dry-run` (nothing changed) and, under `--into`, is the live
   *  file's size (still unchanged) — the copy's size is `into.copyBytes`. */
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
  into?: { path: string; copyBytes: number; mv: string; rowCountMismatches: string[] };
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
  const beforeBytes = statSync(path).size;
  const db = await openDatabase(path, busyTimeoutMs);
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

async function compactOneDatabase(
  name: CompactableDb,
  path: string,
  busyTimeoutMs: number,
  intoDir: string | undefined,
): Promise<DbCompactReport> {
  const beforeBytes = statSync(path).size;
  const db = await openDatabase(path, busyTimeoutMs);
  try {
    if (intoDir !== undefined) {
      // NEVER writes to `db` (the live connection) — `VACUUM INTO` is a consistent read-side
      // snapshot, not a write to its source. Step (a)'s FTS `'optimize'` runs against the COPY
      // instead, once it exists, followed by a second VACUUM (of the copy, not the live file) to
      // reclaim the space that optimize's rewrite frees — the copy is not "live", so nothing stops
      // a second pass on it. This is what keeps the live file byte-for-byte untouched under
      // `--into`, which the whole point of the flag is to guarantee.
      mkdirSync(intoDir, { recursive: true });
      const destPath = join(intoDir, name);
      if (existsSync(destPath)) {
        throw new Error(
          `compact --into: ${destPath} already exists — VACUUM INTO refuses to overwrite it`,
        );
      }
      try {
        db.exec(`VACUUM INTO ${quoteSqlString(destPath)}`);
      } catch (e) {
        if (busyReason(e)) throw new CompactBusyError(name);
        throw e;
      }
      const copyDb = await openDatabase(destPath, busyTimeoutMs);
      let ftsOptimized: string[];
      let integrity: { ok: boolean; issues: string[] };
      let rowCountMismatches: string[];
      try {
        ftsOptimized = optimizeFtsTables(copyDb);
        copyDb.exec("VACUUM");
        integrity = verifyIntegrity(copyDb);
        rowCountMismatches = verifyRowCounts(db, copyDb);
      } finally {
        copyDb.close?.();
      }
      const ok = integrity.ok && rowCountMismatches.length === 0;
      const copyBytes = statSync(destPath).size;
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
        },
      };
    }

    const ftsOptimized = optimizeFtsTables(db);
    try {
      db.exec("VACUUM");
    } catch (e) {
      if (busyReason(e)) throw new CompactBusyError(name);
      throw e;
    }
    const integrity = verifyIntegrity(db);
    const afterBytes = statSync(path).size;
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
  if (r.dryRun) {
    process.stdout.write(
      `${r.db}: ${r.beforeBytes} bytes on disk, ${r.freelistBytes ?? 0} bytes reclaimable by VACUUM (freelist)\n`,
    );
    for (const [t, n] of Object.entries(r.ftsDataRows ?? {})) {
      process.stdout.write(`  ${t}_data: ${n} rows\n`);
    }
    return;
  }
  const tail = r.ftsOptimized.length > 0 ? `, optimized ${r.ftsOptimized.join(", ")}` : "";
  if (r.into) {
    process.stdout.write(
      `${r.db}: live ${r.beforeBytes} bytes, copy ${r.into.copyBytes} bytes (${r.reclaimedBytes} reclaimable)${tail}\n`,
    );
    process.stdout.write(`  verified copy at ${r.into.path}\n`);
    process.stdout.write(`  to install it: ${r.into.mv}\n`);
  } else {
    process.stdout.write(
      `${r.db}: ${r.beforeBytes} -> ${r.afterBytes} bytes (${r.reclaimedBytes} reclaimed)${tail}\n`,
    );
  }
  if (!r.integrityOk) {
    for (const issue of r.integrityIssues) process.stderr.write(`  ! ${issue}\n`);
  }
}

/**
 * `obsidian-tc compact` — see the file header for the ruling on in-place VACUUM vs `--into`.
 *
 * Runs cache.db then experiential.db, in order, skipping either that does not exist (a fresh
 * install, or a deployment with the experiential tier never opened). A SQLITE_BUSY on either
 * VACUUM aborts the whole command with a plain-language message and exit 1, rather than leaving
 * the operator to decode a raw SQLite error; a failed integrity/row-count verification also exits
 * non-zero, but does not abort the loop — the OTHER database still gets compacted and reported.
 */
export async function run_compact(cmd: Cmd<"compact">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  const busyTimeoutMs = cfg.db.busyTimeoutMs;
  const dryRun = cmd.dryRun === true;
  const reports: DbCompactReport[] = [];
  let sawIssue = false;

  for (const name of COMPACTABLE_DBS) {
    const path = join(cfg.cacheDir, name);
    if (!existsSync(path)) continue;
    try {
      const report = dryRun
        ? await dryRunOneDatabase(name, path, busyTimeoutMs)
        : await compactOneDatabase(name, path, busyTimeoutMs, cmd.into);
      reports.push(report);
      if (!report.integrityOk) sawIssue = true;
    } catch (e) {
      if (e instanceof CompactBusyError) {
        process.stderr.write(
          `compact: ${e.message} — refusing to VACUUM while contended. Retry once nothing else ` +
            `has it open, or run with --dry-run to inspect without writing.\n`,
        );
        process.exit(1);
      }
      throw e;
    }
  }

  if (reports.length === 0) {
    process.stdout.write("compact: no cache.db or experiential.db found — nothing to compact\n");
    return;
  }

  for (const r of reports) printReport(r);
  if (!dryRun && cmd.into === undefined) {
    process.stdout.write(
      "note: VACUUM needs roughly as much free disk space as the database's own current size " +
        "(it writes a full replacement before the original is freed) — about 2x headroom overall.\n",
    );
  }

  if (cmd.json !== undefined) {
    writeFileSync(cmd.json, JSON.stringify(reports, null, 2));
    process.stdout.write(`wrote ${cmd.json}\n`);
  }

  if (sawIssue) process.exit(1);
}
