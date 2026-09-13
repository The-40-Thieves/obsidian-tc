// THE-1039 (GH #930) — `obsidian-tc compact`: the operator compaction path 26 CLI verbs never had.
// `maintenance.ts`'s sweep never VACUUMs ("disruptive under WAL") and runs only a BOUNDED FTS5
// 'merge' (GH #929); this is the explicit full-'optimize' path, reached on purpose.
//
// RULING (do not re-open): the default path VACUUMs IN PLACE and never swaps files — a rename over a
// database another process holds open strands that process on the old inode, worse than the space
// reclaimed. `--into <dir>` is the copy path: the live file is untouched and the exact `mv` is
// printed for the operator to run once nothing else has the database open; this command never moves.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dbFootprintBytes, FTS_TABLE_NAMES, tableExists } from "../../db/introspect";
import { openDatabase } from "../../db/open";
import { forcedCompactIntoFailure, forcedPostOptimizeThrow } from "../../db/pragmas";
import { busyReason } from "../../db/txn";
import type { Database } from "../../db/types";
import { type Cmd, resolveOrUsageExit } from "../shared";

const COMPACTABLE_DBS = ["cache.db", "experiential.db"] as const;
type CompactableDb = (typeof COMPACTABLE_DBS)[number];

/** A table whose `COUNT(*)` threw on at least one connection, with the error explaining it. */
export interface NotComparableTable {
  table: string;
  reason: string;
}

/** THE-1039 (A1, A4) — an EXPECTED, reportable failure for one database, not a bug. `run_compact`
 *  catches `unknown` per database, so EVERY error becomes a report row; this carries only what
 *  `errorReport` can SAY about one. One class with optional facts, not a subclass each (M8): only
 *  `CompactIntoFailedError` is `instanceof`-checked. `ftsOptimized`: what `'optimize'` committed. */
export class CompactError extends Error {
  constructor(
    message: string,
    readonly facts: { busy?: boolean; destPath?: string; ftsOptimized?: string[] } = {},
  ) {
    super(message);
  }
}

/** A VACUUM hit SQLITE_BUSY past `db.busyTimeoutMs`: an operator needs "something else has this
 *  open", not a raw error code. */
export function compactBusyError(dbName: CompactableDb, ftsOptimized?: string[]): CompactError {
  return new CompactError(`${dbName} is busy — another connection holds it open`, {
    busy: true,
    ...(ftsOptimized !== undefined ? { ftsOptimized } : {}),
  });
}

/** `--into <dir>` already contains this database's file name. Routed through the same per-database
 *  reporting path as every other expected failure, not cli.ts's generic `fatal:` handler. */
export function compactDestinationExistsError(destPath: string): CompactError {
  return new CompactError(`${destPath} already exists — VACUUM INTO refuses to overwrite it`);
}

/** E1 — any step AFTER `VACUUM INTO` created `destPath` throwing (the copy's open, `'optimize'`, its
 *  VACUUM, the checkpoint, verification) used to name only the LIVE path, hiding the copy. */
export class CompactIntoFailedError extends CompactError {
  constructor(
    readonly destPath: string,
    cause: unknown,
    ftsOptimized: string[] = [],
  ) {
    super(
      `--into failed after creating ${destPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { destPath, ftsOptimized },
    );
  }
}

/** One database's compaction (or dry-run) result — one type for every shape, so `run_compact` prints
 *  and `--json`-serializes through one path. Bytes are the FOOTPRINT (A2's `dbFootprintBytes`). */
export interface DbCompactReport {
  db: CompactableDb;
  path: string;
  dryRun: boolean;
  /** A1/A4: set when this database's operation failed outright. Every other field is a best-effort
   *  pre-failure snapshot; `integrityOk` is `false`, driving the exit code as a failure does. */
  error?: string;
  /** E1 — any `--into` outcome leaving a copy needing attention: a step failing after `VACUUM INTO`
   *  created it, or a failed verification. Unset when `into.mv` already says "install this". */
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
  /** M6: a checkpoint a reader prevented — invisible before, while `afterBytes` counted the `-wal` it
   *  left (a NEGATIVE reclaim, measured). Reported; no failure, no exit-code change. */
  checkpointBlocked?: string;
  /** I2 — `--into`'s three outcomes. "partial" is exit 0 and DOES recommend the copy, naming the
   *  un-row-counted tables; it never prints the bare words "verified copy". */
  verification?: "verified" | "partial" | "failed";
  /** I2 — tables whose COUNT(*) hit an UNAVAILABLE MODULE (vec0 without sqlite-vec): copied
   *  page-for-page (measured), unprovable; any OTHER count error is a failure. */
  notComparable?: NotComparableTable[];
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

/** Single-quote a path for SQL — VACUUM INTO takes a literal, not a bind parameter (rerun.ts has its
 *  own copy; not imported, to keep this command's deps to db/*). */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Single-quote a path for a POSIX shell command line (the printed `mv`). */
function quoteShString(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The FTS5 integrity-check over any FTS_TABLE_NAMES table (fts.ts's is notes_fts-only and repairs). */
function ftsIntegrityCheck(db: Database, table: string): { ok: boolean; reason?: string } {
  try {
    db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}

/** Every table worth comparing for `--into`'s row-count check: every real one, MINUS sqlite-internal
 *  ones and MINUS each FTS table's shadow tables (`_data`, `_idx`, `_content`, `_docsize`, `_config`),
 *  EXPECTED to disagree once `'optimize'` merges. The FTS table itself IS compared. */
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

/** Row count per table, or the raw error that prevented counting. I2: a failure became `-1` on BOTH
 *  connections and `-1 === -1` read as a MATCH, so `COUNT(*) FROM vec_chunks` ("no such module: vec0")
 *  left a semantic store's largest table unverified under "verified copy". */
function tableRowCounts(db: Database, tables: string[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const t of tables) {
    try {
      out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    } catch (e) {
      // The RAW error: callers word it ("not comparable (…)") where they present it.
      out[t] = (e as Error)?.message ?? String(e);
    }
  }
  return out;
}

/** Compare each table's row count between the live database and its `VACUUM INTO` copy. Best-effort:
 *  the live file can be written between snapshot and comparison, so a mismatch there may not be
 *  corruption — reported anyway, since this cannot tell. */
function verifyRowCounts(
  live: Database,
  copy: Database,
): { mismatches: string[]; notComparable: NotComparableTable[] } {
  const tables = realTableNames(live);
  const liveCounts = tableRowCounts(live, tables);
  const copyCounts = tableRowCounts(copy, tables);
  const notComparable: NotComparableTable[] = [];
  const mismatches: string[] = [];
  for (const t of tables) {
    // "Not comparable" is ONLY the unavailable-module class (vec0 without sqlite-vec): copied
    // page-for-page, unprovable. ANY other count error (busy, missing) FAILS — an unchecked table
    // must never reach an install recommendation.
    const errors: { side: string; error: string }[] = [];
    for (const [side, v] of [
      ["live", liveCounts[t]],
      ["copy", copyCounts[t]],
    ] as const) {
      if (typeof v === "string") errors.push({ side, error: v });
    }
    const hard = errors.filter((e) => !/no such module/i.test(e.error));
    const unavailable = errors.find((e) => /no such module/i.test(e.error));
    if (hard.length > 0) {
      for (const e of hard) mismatches.push(`${t}: count failed on ${e.side}: ${e.error}`);
    } else if (unavailable !== undefined) {
      notComparable.push({ table: t, reason: unavailable.error });
    } else if (liveCounts[t] !== copyCounts[t]) {
      mismatches.push(`${t}: live=${liveCounts[t]} copy=${copyCounts[t]}`);
    }
  }
  return { mismatches, notComparable };
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

/** Step a: FTS5 `'optimize'` per present FTS table — the live connection in place, the copy under
 *  `--into`, since the live file must never be written. */
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

/** Step c: `PRAGMA integrity_check` plus the FTS integrity-check per present FTS table, on whichever
 *  connection is passed (live after an in-place VACUUM, the copy under `--into`). */
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
 *  empties `-wal` into the main file, so a footprint read after this is accurate. */
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
  // sqlite.org/lang_vacuum.html, "the original database file is unchanged") plus the comparison, so
  // `readonly: true` never flips a DELETE-mode database into WAL. In place, VACUUM needs a WRITER.
  const db = await openDatabase(path, busyTimeoutMs, { readonly: intoDir !== undefined });
  try {
    if (intoDir !== undefined) {
      // `db` is NEVER written to here — 'optimize' and the reclaiming VACUUM both run against the
      // COPY once it exists, which is what keeps the live file byte-for-byte untouched.
      mkdirSync(intoDir, { recursive: true });
      const destPath = join(intoDir, name);
      if (existsSync(destPath)) throw compactDestinationExistsError(destPath);

      let copyDb: Database | undefined;
      const ftsOptimized: string[] = [];
      let integrity: { ok: boolean; issues: string[] };
      let rowCounts: { mismatches: string[]; notComparable: NotComparableTable[] };
      let snapshotAt: string;
      let checkpointBlocked: string | undefined;
      try {
        db.exec(`VACUUM INTO ${quoteSqlString(destPath)}`);
        snapshotAt = new Date().toISOString(); // THE-1039 fix round 1 (A5)
        copyDb = await openDatabase(destPath, busyTimeoutMs);
        // M1: stands in for the copy-side `'optimize'` throwing, or (`delete:<table>`) a real
        // copy-vs-live divergence — see `forcedCompactIntoFailure`.
        const forced = forcedCompactIntoFailure();
        if (forced?.kind === "throw") throw forced.error;
        if (forced?.kind === "countError") copyDb.exec(`DROP TABLE "${forced.table}"`);
        if (forced?.kind === "delete") {
          copyDb.exec(
            `DELETE FROM "${forced.table}" WHERE rowid = (SELECT MIN(rowid) FROM "${forced.table}")`,
          );
        }
        optimizeFtsTables(copyDb, ftsOptimized);
        copyDb.exec("VACUUM");
        checkpointBlocked = checkpointTruncate(copyDb);
        integrity = verifyIntegrity(copyDb);
        rowCounts = verifyRowCounts(db, copyDb);
      } catch (e) {
        // E1 + round 4: classify on "does the copy exist" BEFORE the busy check — a busy from a
        // copy-side step used to lose `destPath`. The busy WORDING survives as the wrapped cause.
        if (existsSync(destPath)) {
          throw new CompactIntoFailedError(
            destPath,
            busyReason(e) ? compactBusyError(name) : e,
            ftsOptimized,
          );
        }
        if (busyReason(e)) throw compactBusyError(name);
        throw e;
      } finally {
        copyDb?.close?.();
      }
      // F1: `into` is populated either way (the copy stays on disk), but printReport only
      // recommends installing it when `ok`.
      const ok = integrity.ok && rowCounts.mismatches.length === 0;
      const verification = !ok
        ? "failed"
        : rowCounts.notComparable.length > 0
          ? "partial"
          : "verified";
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
        verification,
        ...(rowCounts.notComparable.length > 0 ? { notComparable: rowCounts.notComparable } : {}),
        ...(db.readonlyMode !== undefined ? { readonlyMode: db.readonlyMode } : {}),
        integrityIssues: [
          ...integrity.issues,
          ...rowCounts.mismatches.map((m) => `row-count mismatch: ${m}`),
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
          rowCountMismatches: rowCounts.mismatches,
          snapshotAt,
        },
      };
    }

    // M4: accumulated in place, so a failure LATER (a busy VACUUM) still reports committed FTS work.
    const ftsOptimized: string[] = [];
    let checkpointBlocked: string | undefined;
    try {
      optimizeFtsTables(db, ftsOptimized);
      const forced = forcedPostOptimizeThrow(); // J2's test seam — see that function
      if (forced !== undefined) throw forced;
      db.exec("VACUUM");
      checkpointBlocked = checkpointTruncate(db); // F3 — see that function's own comment
    } catch (e) {
      if (busyReason(e)) throw compactBusyError(name, ftsOptimized);
      // J2: ANY failure here must carry the merge `'optimize'` already committed — a report reading
      // `ftsOptimized: []` while `<t>_data` shrank is simply false.
      throw new CompactError(e instanceof Error ? e.message : String(e), { ftsOptimized });
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
      // F1: only reached when verification passed. I2: "partial" installs too, but the bare words
      // "verified copy" are reserved for the outcome that proved EVERY table.
      if (r.verification === "partial") {
        const named = (r.notComparable ?? [])
          .map((t) => `${t.table} (not comparable: ${t.reason})`)
          .join(", ");
        process.stdout.write(`  copy verified EXCEPT ${named}\n`);
        process.stdout.write(
          "  those tables were copied page-for-page by VACUUM INTO but not row-counted\n",
        );
      } else {
        process.stdout.write(`  verified copy at ${r.into.path}\n`);
      }
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

/** J1 — the paths `--json` must never be pointed at: the managed databases and their `-wal`/`-shm`
 *  sidecars, in `cacheDir` and under `--into`. `--json <cacheDir>/cache.db` TRUNCATED the database it
 *  had just inspected; `--json <into>/cache.db` overwrote the verified copy. Win32-insensitive. */
function jsonAliasError(
  cacheDir: string,
  into: string | undefined,
  json: string,
): string | undefined {
  const managed = [cacheDir, ...(into !== undefined ? [into] : [])].flatMap((dir) =>
    COMPACTABLE_DBS.flatMap((name) => {
      const base = resolve(join(dir, name));
      return [base, `${base}-wal`, `${base}-shm`];
    }),
  );
  const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = norm(resolve(json));
  return managed.some((m) => norm(m) === target)
    ? `--json ${json} would overwrite a database this command manages — pick a path outside ` +
        `${cacheDir}${into !== undefined ? ` and ${into}` : ""}`
    : undefined;
}

/** A1/A4: one database's failure as a report row, so the loop records it and moves on. Takes
 *  `unknown`: cli.ts's `fatal:` handler printed `(err as Error).message` too, so wrapping ANY error
 *  loses nothing while letting the OTHER database compact. */
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

/** `obsidian-tc compact` — see the file header for the in-place-vs-`--into` ruling; runs cache.db then
 *  experiential.db, skipping either absent. A1 incident closed: a `SQLITE_BUSY` on the SECOND database
 *  `process.exit(1)`d before the FIRST's success was reported, so every outcome lands in `reports`
 *  first, report/`--json` always emit, and the exit code is decided once, last. */
export async function run_compact(cmd: Cmd<"compact">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  // J1: before ANY database is opened, so a mistyped path changes nothing.
  const aliased =
    cmd.json !== undefined ? jsonAliasError(cfg.cacheDir, cmd.into, cmd.json) : undefined;
  if (aliased !== undefined) {
    process.stderr.write(`${aliased}\n`);
    process.exit(1);
  }
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
