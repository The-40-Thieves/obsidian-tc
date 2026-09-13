// THE-1039 (GH #930) — `obsidian-tc compact`: the operator compaction path 26 CLI verbs never had.
// `maintenance.ts`'s sweep never VACUUMs ("disruptive under WAL") and runs only a BOUNDED FTS5
// 'merge' (GH #929); this is the explicit full-'optimize' path, reached on purpose.
//
// RULING (do not re-open): the default path VACUUMs IN PLACE and never swaps files — a rename over a
// database another process holds open strands that process on the old inode, worse than the space
// reclaimed. `--into <dir>` is the copy path: the live file is untouched and the exact `mv` is
// printed for the operator to run once nothing else has the database open; this command never moves.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbFootprintBytes, FTS_TABLE_NAMES, tableExists } from "../../db/introspect";
import { openDatabase } from "../../db/open";
import { forcedCompactIntoFailure } from "../../db/pragmas";
import { busyReason } from "../../db/txn";
import type { Database } from "../../db/types";
import { type Cmd, resolveOrUsageExit } from "../shared";

const COMPACTABLE_DBS = ["cache.db", "experiential.db"] as const;
type CompactableDb = (typeof COMPACTABLE_DBS)[number];

/** THE-1039 (A1, A4) — an EXPECTED, reportable failure for one database, as opposed to a bug.
 *  `run_compact` catches `unknown` per database (see its comment for the incident), so EVERY error
 *  becomes a report row; this class only carries what `errorReport` can SAY about one. ONE class
 *  with optional facts, not a subclass per failure (M8): only `CompactIntoFailedError` is ever
 *  `instanceof`-checked. `ftsOptimized` is the PARTIAL list `'optimize'` had already committed
 *  before the failure (M4) — real work an operator must hear about even if the VACUUM never ran. */
export class CompactError extends Error {
  constructor(
    message: string,
    readonly facts: { busy?: boolean; destPath?: string; ftsOptimized?: string[] } = {},
  ) {
    super(message);
  }
}

/** A VACUUM (in place or INTO) hit SQLITE_BUSY — another connection holds the database open past
 *  `db.busyTimeoutMs`. An operator needs "something else has this open", not a raw error code. */
export function compactBusyError(dbName: CompactableDb, ftsOptimized?: string[]): CompactError {
  return new CompactError(`${dbName} is busy — another connection holds it open`, {
    busy: true,
    ...(ftsOptimized !== undefined ? { ftsOptimized } : {}),
  });
}

/** `--into <dir>` already contains this database's file name. Routed through the same
 *  plain-language, per-database reporting path as every other expected failure here, rather than
 *  cli.ts's generic `fatal:` handler. */
export function compactDestinationExistsError(destPath: string): CompactError {
  return new CompactError(`${destPath} already exists — VACUUM INTO refuses to overwrite it`);
}

/** E1 — any step AFTER `VACUUM INTO` created (or partially created) `destPath` throwing: the copy's
 *  open, `'optimize'`, its VACUUM, the checkpoint, an integrity check, the row-count comparison.
 *  That used to propagate naming only the LIVE path, leaving the copy invisible and a retry failing
 *  on "already exists". `instanceof`-checked by `errorReport`, which is why it stays a type. */
export class CompactIntoFailedError extends CompactError {
  constructor(
    readonly destPath: string,
    cause: unknown,
  ) {
    super(
      `--into failed after creating ${destPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { destPath },
    );
  }
}

/** One database's compaction (or dry-run inspection) result — every shape is one type so
 *  `run_compact` prints and `--json`-serializes through one path. Byte counts are the FOOTPRINT
 *  (main + `-wal`, A2's `dbFootprintBytes`, as doctor's `db.reclaimable-space` uses), bar
 *  `freelistBytes`. */
export interface DbCompactReport {
  db: CompactableDb;
  path: string;
  dryRun: boolean;
  /** A1/A4: set when this database's operation failed outright (busy, or an `--into` collision).
   *  Every other field is a best-effort pre-failure snapshot; `integrityOk` is `false`, driving the
   *  exit code as a verification failure does. */
  error?: string;
  /** E1 — any `--into` outcome leaving a copy needing operator attention: a step failing after
   *  `VACUUM INTO` created it (with `error`), or a run that failed verification (`integrityOk:
   *  false`, no `error`). Unset for a verified copy, whose `into.mv` already says "install this". */
  destination?: string;
  /** E1 — whether `destination` exists on disk right now, checked fresh at report-build time
   *  (never assumed from whichever step failed), so a report never claims a file is there when
   *  it is not. */
  retainedCopy?: boolean;
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
  /** H2: which strategy the INSPECTION connection took (`--dry-run`, `--into`'s source read; absent
   *  in place, which opens writable by design). `"fallback"` is reported out loud — see
   *  `printReport` — because bytes are only guaranteed unchanged on `"native"`. */
  readonlyMode?: "native" | "fallback";
  /** M6: a checkpoint another connection's read prevented — invisible before, while `afterBytes`
   *  counted the `-wal` it left behind (a NEGATIVE reclaim, measured). Reported, but NOT a
   *  verification failure and NOT an exit-code change: nothing is wrong, less was reclaimed. */
  checkpointBlocked?: string;
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
 *  idiom as workspace/rerun.ts's private copy, not imported, to keep this command's deps to db/*. */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Single-quote a path for a POSIX shell command line (the printed `mv`). */
function quoteShString(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The FTS5 integrity-check special command over any table in FTS_TABLE_NAMES — fts.ts's
 *  `verifyNotesFtsIntegrity` is notes_fts-specific and also repairs; this needs the bare probe. */
function ftsIntegrityCheck(db: Database, table: string): { ok: boolean; reason?: string } {
  try {
    db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}

/** Every table worth comparing for the `--into` row-count check: every real one, MINUS the
 *  sqlite-internal ones and MINUS each FTS table's shadow tables (`<t>_data`, `_idx`, `_content`,
 *  `_docsize`, `_config`), which are EXPECTED to disagree once `optimizeFtsTables` merges segments
 *  on the copy. The FTS virtual table IS compared: its count is the document count. */
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

/** Row count per table, or the reason it could not be counted. I2: a failure became `-1` on BOTH
 *  connections and `-1 === -1` read as a MATCH, so on a semantic store `COUNT(*) FROM vec_chunks`
 *  ("no such module: vec0" — this command never loads sqlite-vec) left the largest table unverified
 *  under the words "verified copy". Uncountable on either side is now a reported mismatch. `VACUUM
 *  INTO` does preserve vec0 content with the module absent (measured), so this is a VERIFICATION
 *  gap, not corruption: the copy is fine, this command cannot prove it for that table. */
function tableRowCounts(db: Database, tables: string[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const t of tables) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    } catch (e) {
      out[t] = `not comparable (${(e as Error)?.message ?? String(e)})`;
    }
  }
  return out;
}

/** Compare every table's row count between the live database and its `VACUUM INTO` copy.
 *  Best-effort, not a proof: the live database can be written between the snapshot and this
 *  comparison, so a mismatch on an actively-written table is not necessarily corruption — reported
 *  either way, since this command cannot tell it from "the copy is short a table". */
function verifyRowCounts(live: Database, copy: Database): string[] {
  const tables = realTableNames(live);
  const liveCounts = tableRowCounts(live, tables);
  const copyCounts = tableRowCounts(copy, tables);
  const mismatch = (t: string): boolean =>
    typeof liveCounts[t] !== "number" ||
    typeof copyCounts[t] !== "number" ||
    liveCounts[t] !== copyCounts[t];
  return tables.filter(mismatch).map((t) => `${t}: live=${liveCounts[t]} copy=${copyCounts[t]}`);
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
      ...(db.readonlyMode !== undefined ? { readonlyMode: db.readonlyMode } : {}),
      freelistBytes: freelistCount * pageSize,
      ftsDataRows,
    };
  } finally {
    db.close?.();
  }
}

/** Step a: FTS5 `'optimize'` on every present FTS table. In place that is the live connection;
 *  under `--into` it is the copy, since the live file must never be written to. */
function optimizeFtsTables(db: Database, into: string[] = []): string[] {
  const optimized = into;
  for (const t of FTS_TABLE_NAMES) {
    if (tableExists(db, t)) {
      db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
      optimized.push(t);
    }
  }
  return optimized;
}

/** Step c: `PRAGMA integrity_check` plus the FTS integrity-check insert per present FTS table, on
 *  whichever connection is passed (live after an in-place VACUUM, the copy under `--into`). */
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

/** F3 — `VACUUM`'s freed pages can sit entirely in the WAL until checkpointed (measured: a 1.2 MB
 *  `-wal` held everything freed while the main file stayed at its pre-VACUUM size). `TRUNCATE`
 *  checkpoints every frame in and empties `-wal`, so a footprint read after this is accurate. */
function checkpointTruncate(db: Database): string | undefined {
  // M6: this PRAGMA RETURNS `(busy, log, checkpointed)` instead of throwing; `busy = 1` means a
  // reader prevented the truncation, so `-wal` survives and the footprint still counts it.
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
  return row?.busy === 1
    ? "WAL checkpoint was blocked by another connection; after-size includes the -wal"
    : undefined;
}

async function compactOneDatabase(
  name: CompactableDb,
  path: string,
  busyTimeoutMs: number,
  intoDir: string | undefined,
): Promise<DbCompactReport> {
  const beforeBytes = dbFootprintBytes(path);
  // F2: under `--into`, `db` only runs `VACUUM INTO` (a read of the source per
  // sqlite.org/lang_vacuum.html, "the original database file is unchanged") plus the row-count
  // comparison, so `readonly: true` never flips a DELETE-mode database into WAL. The in-place path
  // runs VACUUM itself and so needs a WRITABLE connection.
  const db = await openDatabase(path, busyTimeoutMs, { readonly: intoDir !== undefined });
  try {
    if (intoDir !== undefined) {
      // `db` is NEVER written to here — 'optimize' and the reclaiming VACUUM both run against the
      // COPY once it exists, which is what keeps the live file byte-for-byte untouched.
      mkdirSync(intoDir, { recursive: true });
      const destPath = join(intoDir, name);
      if (existsSync(destPath)) throw compactDestinationExistsError(destPath);

      let copyDb: Database | undefined;
      let ftsOptimized: string[];
      let integrity: { ok: boolean; issues: string[] };
      let rowCountMismatches: string[];
      let snapshotAt: string;
      let checkpointBlocked: string | undefined;
      try {
        db.exec(`VACUUM INTO ${quoteSqlString(destPath)}`);
        snapshotAt = new Date().toISOString(); // THE-1039 fix round 1 (A5)
        copyDb = await openDatabase(destPath, busyTimeoutMs);
        // M1: stands in for the copy-side `'optimize'` throwing — see `forcedCompactIntoFailure`.
        const forced = forcedCompactIntoFailure();
        if (forced !== undefined) throw forced;
        ftsOptimized = optimizeFtsTables(copyDb);
        copyDb.exec("VACUUM");
        checkpointBlocked = checkpointTruncate(copyDb);
        integrity = verifyIntegrity(copyDb);
        rowCountMismatches = verifyRowCounts(db, copyDb);
      } catch (e) {
        // E1 + round 4: classify on "does the copy exist" BEFORE the busy check — a busy from a
        // copy-side step used to lose `destPath`. The busy WORDING survives as the wrapped cause.
        if (existsSync(destPath)) {
          throw new CompactIntoFailedError(destPath, busyReason(e) ? compactBusyError(name) : e);
        }
        if (busyReason(e)) throw compactBusyError(name);
        throw e;
      } finally {
        copyDb?.close?.();
      }
      // F1: `into` is populated either way (the copy stays on disk), but printReport only
      // recommends installing it when `ok`.
      const ok = integrity.ok && rowCountMismatches.length === 0;
      const copyBytes = dbFootprintBytes(destPath);
      return {
        db: name,
        path,
        dryRun: false,
        // E1: a non-clean --into outcome names its file at the top level too, so a --json
        // consumer checks one field whichever failure shape it was.
        ...(ok ? {} : { destination: destPath, retainedCopy: existsSync(destPath) }),
        beforeBytes,
        afterBytes: beforeBytes, // the LIVE file — untouched by --into
        reclaimedBytes: beforeBytes - copyBytes,
        ftsOptimized,
        integrityOk: ok,
        ...(db.readonlyMode !== undefined ? { readonlyMode: db.readonlyMode } : {}),
        integrityIssues: [
          ...integrity.issues,
          ...rowCountMismatches.map((m) => `row-count mismatch: ${m}`),
        ],
        ...(checkpointBlocked !== undefined ? { checkpointBlocked } : {}),
        into: {
          path: destPath,
          copyBytes,
          // The sidecars belong to the file being replaced: SQLite IGNORES a stale `-wal`/`-shm`
          // whose header does not match its database, so removing them is completeness rather than
          // safety — it stops an operator finding orphans beside the installed copy.
          mv:
            `mv ${quoteShString(destPath)} ${quoteShString(path)} && ` +
            `rm -f ${quoteShString(`${path}-wal`)} ${quoteShString(`${path}-shm`)}`,
          rowCountMismatches,
          snapshotAt,
        },
      };
    }

    // M4: accumulated in place, so a failure LATER (a busy VACUUM) still reports committed FTS work.
    const ftsOptimized: string[] = [];
    let checkpointBlocked: string | undefined;
    try {
      optimizeFtsTables(db, ftsOptimized);
      db.exec("VACUUM");
      checkpointBlocked = checkpointTruncate(db); // F3 — see that function's own comment
    } catch (e) {
      if (busyReason(e)) throw compactBusyError(name, ftsOptimized);
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
      ...(checkpointBlocked !== undefined ? { checkpointBlocked } : {}),
    };
  } finally {
    db.close?.();
  }
}

/** H2: a fallback inspection connection, said out loud — it was previously recorded and never
 *  read, so an operator had no way to know this run carried the weaker guarantee. */
function printFallbackNotice(r: DbCompactReport): void {
  if (r.readonlyMode !== "fallback") return;
  process.stdout.write(
    `  ${r.db}: inspection connection was not read-only on this platform; a dangling WAL left by ` +
      "an unclean shutdown may be checkpointed on close.\n",
  );
}

function printReport(r: DbCompactReport): void {
  if (r.error !== undefined) {
    process.stderr.write(`${r.db}: ${r.error}\n`);
    // E1: name the retained copy even on the crash path, so an operator can find it.
    if (r.destination !== undefined) {
      process.stderr.write(
        `  ${r.retainedCopy ? "an incomplete copy remains" : "no copy file remains"} at ` +
          `${r.destination}` +
          (r.retainedCopy
            ? " — inspect or remove it before retrying --into into this directory.\n"
            : ".\n"),
      );
    }
    return;
  }
  if (r.dryRun) {
    process.stdout.write(
      `${r.db}: ${r.beforeBytes} bytes on disk (main + -wal), ${r.freelistBytes ?? 0} bytes reclaimable by VACUUM (freelist)\n`,
    );
    for (const [t, n] of Object.entries(r.ftsDataRows ?? {})) {
      process.stdout.write(`  ${t}_data: ${n} rows\n`);
    }
    printFallbackNotice(r);
    return;
  }
  const tail = r.ftsOptimized.length > 0 ? `, optimized ${r.ftsOptimized.join(", ")}` : "";
  const note = (): void => {
    if (r.checkpointBlocked !== undefined) process.stdout.write(`  note: ${r.checkpointBlocked}\n`);
  };
  if (r.into) {
    process.stdout.write(
      `${r.db}: live ${r.beforeBytes} bytes, copy ${r.into.copyBytes} bytes (${r.reclaimedBytes} reclaimable, main + -wal)${tail}\n`,
    );
    note();
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
      // F1: the copy FAILED verification — left in place, not recommended for install. E1: same
      // "inspect or remove" wording as the crash path above, regardless of which failure shape.
      process.stdout.write(
        `  copy FAILED verification — left at ${r.into.path} for inspection; DO NOT install it\n` +
          "  inspect or remove it before retrying --into into this directory.\n",
      );
      for (const issue of r.integrityIssues) process.stderr.write(`  ! ${issue}\n`);
    }
    printFallbackNotice(r);
    return;
  }
  process.stdout.write(
    `${r.db}: ${r.beforeBytes} -> ${r.afterBytes} bytes (${r.reclaimedBytes} reclaimed, main + -wal)${tail}\n`,
  );
  note();
  if (!r.integrityOk) {
    for (const issue of r.integrityIssues) process.stderr.write(`  ! ${issue}\n`);
  }
}

/** A1/A4: one database's failure as a report row, so the loop records it and moves on. Takes
 *  `unknown`, not just `CompactError`: cli.ts's `fatal:` handler printed `(err as Error).message`
 *  too, so wrapping ANY error loses nothing while letting the OTHER database compact. */
function errorReport(
  name: CompactableDb,
  path: string,
  dryRun: boolean,
  e: unknown,
): DbCompactReport {
  const message = e instanceof Error ? e.message : String(e);
  // E1: destPath is checked fresh here, not trusted from whichever step threw.
  const into =
    e instanceof CompactIntoFailedError
      ? { destination: e.destPath, retainedCopy: existsSync(e.destPath) }
      : {};
  // M4: FTS work already committed before the failure, not an invented empty list.
  const ftsOptimized = e instanceof CompactError ? (e.facts.ftsOptimized ?? []) : [];
  return {
    db: name,
    path,
    dryRun,
    error: message,
    ...into,
    beforeBytes: existsSync(path) ? dbFootprintBytes(path) : 0,
    afterBytes: existsSync(path) ? dbFootprintBytes(path) : 0,
    reclaimedBytes: 0,
    ftsOptimized,
    integrityOk: false,
    integrityIssues: [message],
  };
}

/** `obsidian-tc compact` — see the file header for the in-place-vs-`--into` ruling. Runs cache.db
 *  then experiential.db, skipping either that is absent. A1 incident closed: a `SQLITE_BUSY` on the
 *  SECOND database used to `process.exit(1)` before the FIRST one's success was reported. Every
 *  outcome lands in `reports` first; report/`--json` always emit, and the exit code goes non-zero
 *  once at the end if any database failed or failed verification. */
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
