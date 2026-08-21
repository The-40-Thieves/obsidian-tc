// THE-891 item 6 — the 20260820_001 migration: preference_profile/preference_deltas gain
// `scope_caller`. Pinned here, mirroring plane-vault-id-migration.test.ts's shape for the analogous
// THE-710/20260803_001 migration: seed OLD-shape rows on the pre-migration schema, apply the new
// migration on the SAME db (runMigrations is incremental — see migrate.ts), and assert the
// disposition the migration header documents: PURGE, not backfill.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");

const PRE_MIGRATION = [
  { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: sql("20260711_002_agent_episodes.sql") },
  { version: "20260712_001", sql: sql("20260712_001_preference_profile.sql") },
  { version: "20260803_001", sql: sql("20260803_001_preference_vault_id.sql") },
];
const THE_MIGRATION = {
  version: "20260820_001",
  sql: sql("20260820_001_preference_scope_caller.sql"),
};

function preMigrationDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, PRE_MIGRATION);
  return db;
}

describe("20260820_001 preference scope_caller migration", () => {
  it("adds scope_caller to preference_deltas, default '', and purges pre-existing rows", () => {
    const db = preMigrationDb();
    db.prepare(
      "INSERT INTO preference_deltas (vault_id, ts, key, op, value, evidence, version) VALUES ('main', 1, 'preferred.search_mode', 'add', 'search_text', 'e', 1)",
    ).run();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM preference_deltas").get() as { n: number }).n,
    ).toBe(1);

    runMigrations(db, [...PRE_MIGRATION, THE_MIGRATION]);

    const cols = (
      db.prepare("PRAGMA table_info(preference_deltas)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("scope_caller");
    // PURGE, not backfill — the pre-migration row is gone, not carried forward with scope_caller=''.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM preference_deltas").get() as { n: number }).n,
    ).toBe(0);
    // The column's own DEFAULT still applies to any row written WITHOUT naming it (e.g. an older
    // caller, or a raw INSERT in a test fixture) — that is a property of the column, not of the
    // rows that predated it.
    db.prepare(
      "INSERT INTO preference_deltas (vault_id, ts, key, op, value, evidence, version) VALUES ('main', 1, 'preferred.search_mode', 'add', 'search_text', 'e', 1)",
    ).run();
    const row = db.prepare("SELECT scope_caller FROM preference_deltas").get() as {
      scope_caller: string;
    };
    expect(row.scope_caller).toBe("");
  });

  it("rebuilds preference_profile with scope_caller leading the key, and purges pre-existing rows", () => {
    const db = preMigrationDb();
    db.prepare(
      "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main', 'preferred.search_mode', 'search_text', 1.0, 1, 0, NULL)",
    ).run();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM preference_profile").get() as { n: number }).n,
    ).toBe(1);

    runMigrations(db, [...PRE_MIGRATION, THE_MIGRATION]);

    const pk = (
      db.prepare("PRAGMA table_info(preference_profile)").all() as {
        name: string;
        pk: number;
      }[]
    )
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["vault_id", "scope_caller", "key"]);
    // PURGE, not backfill — same disposition as preference_deltas above, for the same reason: no
    // row ever recorded a caller, so a backfilled '' would be an invented attribution.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM preference_profile").get() as { n: number }).n,
    ).toBe(0);
  });

  it("two callers can hold the same (vault, key) independently post-migration", () => {
    const db = preMigrationDb();
    runMigrations(db, [...PRE_MIGRATION, THE_MIGRATION]);
    const ins = db.prepare(
      "INSERT INTO preference_profile (vault_id, scope_caller, key, value, weight, version, updated_at, provenance) VALUES (?, ?, 'preferred.search_mode', 'search_text', 1.0, 1, 0, NULL)",
    );
    ins.run("main", "alice");
    expect(() => ins.run("main", "bob")).not.toThrow();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM preference_profile").get() as { n: number }).n,
    ).toBe(2);
  });
});
