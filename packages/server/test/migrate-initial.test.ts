import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { openMemoryDb } from "./helpers";

const initialSql = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

describe("initial migration via runner", () => {
  it("applies the real initial schema and is idempotent", () => {
    const db = openMemoryDb();
    const applied = runMigrations(db, [{ version: "20260519_001", sql: initialSql }], {
      version: "0.0.0-test",
    });
    expect(applied).toEqual(["20260519_001"]);

    const mig = db
      .prepare("SELECT version, obsidian_tc_version FROM schema_migrations WHERE version = ?")
      .get("20260519_001") as { version: string; obsidian_tc_version: string } | undefined;
    expect(mig?.obsidian_tc_version).toBe("0.0.0-test");

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'")
      .get();
    expect(tbl).toBeTruthy();

    expect(runMigrations(db, [{ version: "20260519_001", sql: initialSql }])).toEqual([]);
  });
});
