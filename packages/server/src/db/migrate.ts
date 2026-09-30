import { createHash } from "node:crypto";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "./types";

export interface Migration {
  version: string;
  sql: string;
  /** THE-1130: an optional JS step run in the SAME transaction as `sql`, right after it applies,
   *  before the version is recorded as done. For data that a migration's own SQL cannot compute
   *  correctly/portably (a real example: SQLite's `trim()` strips only ASCII space by default,
   *  diverging from the JS `.trim()` every read path actually uses — a tab/CR-bearing fixture
   *  parsed to a different line count under each). `checksum(m.sql)` is computed from `sql` alone,
   *  so adding, changing, or removing `postApply` never changes a migration's recorded checksum —
   *  only its own `.sql` text does. */
  postApply?: (db: Database) => void;
}
export interface MigrateOptions {
  version?: string;
  now?: () => number;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function ensureMigrationsTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      obsidian_tc_version TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );`,
  );
}

export function runMigrations(
  db: Database,
  migrations: Migration[],
  opts: MigrateOptions = {},
): string[] {
  const now = opts.now ?? Date.now;
  const appVersion = opts.version ?? "1.0.0";
  ensureMigrationsTable(db);
  const sorted = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
  const getRow = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?");
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
  );
  const applied: string[] = [];
  const check = (m: Migration, sum: string): boolean => {
    const existing = getRow.get(m.version) as { checksum: string } | undefined;
    if (!existing) return false;
    if (existing.checksum !== sum) {
      throw new ObsidianTcError("conflict", `migration ${m.version} checksum mismatch`, {
        version: m.version,
        recorded: existing.checksum,
        current: sum,
      });
    }
    return true;
  };
  for (const m of sorted) {
    const sum = checksum(m.sql);
    // Unlocked fast path: a warm boot (everything already applied) never takes the write lock.
    if (check(m, sum)) continue;
    const start = now();
    // IMMEDIATE takes the database write lock up front (waiting out `busy_timeout`), which
    // serializes check-and-apply across every process sharing this file. A plain BEGIN defers the
    // lock to the first write, so two processes that both saw the migration as pending would run
    // it twice: its DDL again, or the `schema_migrations` INSERT into a UNIQUE violation. Outside
    // the try on purpose — a BEGIN that fails (SQLITE_BUSY past busy_timeout) opened no transaction.
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read now that we hold the lock: a process that lost the race finds the winner's row,
      // skips the migration (never re-running non-idempotent DDL), and continues to the next.
      if (check(m, sum)) {
        db.exec("COMMIT");
        continue;
      }
      db.exec(m.sql);
      m.postApply?.(db);
      insert.run(m.version, now(), appVersion, Math.max(0, now() - start), sum);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      if (e instanceof ObsidianTcError) throw e;
      throw new ObsidianTcError(
        "internal",
        `migration ${m.version} failed: ${(e as Error).message}`,
        { version: m.version },
      );
    }
    applied.push(m.version);
  }
  return applied;
}
