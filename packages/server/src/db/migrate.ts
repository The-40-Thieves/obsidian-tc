import { createHash } from "node:crypto";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "./types";

export interface Migration {
  version: string;
  sql: string;
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
  for (const m of sorted) {
    const sum = checksum(m.sql);
    const existing = getRow.get(m.version) as { checksum: string } | undefined;
    if (existing) {
      if (existing.checksum !== sum) {
        throw new ObsidianTcError("conflict", `migration ${m.version} checksum mismatch`, {
          version: m.version,
          recorded: existing.checksum,
          current: sum,
        });
      }
      continue;
    }
    const start = now();
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
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
