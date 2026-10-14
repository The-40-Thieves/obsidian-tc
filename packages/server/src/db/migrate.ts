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
  /** Test-only deterministic interleaving seam; production callers omit it. */
  migrationHooks?: SchemaMigrationHooks;
}

export interface SchemaMigrationRecord {
  version: string;
  checksum: string;
  obsidianTcVersion: string;
  appliedAt: () => number;
  durationMs: () => number;
  /** The checksum is a diagnostic note, not an identity: an existing row counts as applied
   *  whatever it holds. For markers whose text embeds live counts that legitimately differ
   *  between runs (the vec rebuild marker). Never set for a shipped migration. */
  advisoryChecksum?: boolean;
}

export interface SchemaMigrationHooks {
  /** Test seam for the exact gap between the unlocked fast-path read and BEGIN IMMEDIATE. */
  afterPendingCheck?: (version: string) => void;
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

/** Apply and record one schema migration while holding SQLite's write lock. */
export function applySchemaMigration(
  db: Database,
  migration: SchemaMigrationRecord,
  apply: () => void,
  hooks: SchemaMigrationHooks = {},
): boolean {
  const getRow = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?");
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
  );
  const check = (): boolean => {
    const existing = getRow.get(migration.version) as { checksum: string } | undefined;
    if (!existing) return false;
    if (!migration.advisoryChecksum && existing.checksum !== migration.checksum) {
      throw new ObsidianTcError("conflict", `migration ${migration.version} checksum mismatch`, {
        version: migration.version,
        recorded: existing.checksum,
        current: migration.checksum,
      });
    }
    return true;
  };

  if (check()) return false;
  hooks.afterPendingCheck?.(migration.version);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (check()) {
      db.exec("COMMIT");
      return false;
    }
    apply();
    insert.run(
      migration.version,
      migration.appliedAt(),
      migration.obsidianTcVersion,
      migration.durationMs(),
      migration.checksum,
    );
    db.exec("COMMIT");
    return true;
  } catch (error) {
    // SQLite already rolled back on BUSY/FULL/IOERR/NOMEM/INTERRUPT, so ROLLBACK can itself throw
    // "no transaction is active"; that must never replace the error the caller classifies.
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
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
  const applied: string[] = [];
  for (const m of sorted) {
    const sum = checksum(m.sql);
    const start = now();
    try {
      const didApply = applySchemaMigration(
        db,
        {
          version: m.version,
          checksum: sum,
          obsidianTcVersion: appVersion,
          appliedAt: now,
          durationMs: () => Math.max(0, now() - start),
        },
        () => {
          db.exec(m.sql);
          m.postApply?.(db);
        },
        opts.migrationHooks,
      );
      if (!didApply) continue;
    } catch (e) {
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
