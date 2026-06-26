import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { openMemoryDb } from "./helpers";

function db() {
  return openMemoryDb();
}

describe("migration runner", () => {
  it("applies pending migrations in version order", () => {
    const d = db();
    const applied = runMigrations(d, [
      { version: "20260519_001", sql: "CREATE TABLE a(x);" },
      { version: "20260519_002", sql: "CREATE TABLE b(y);" },
    ]);
    expect(applied).toEqual(["20260519_001", "20260519_002"]);
    const rows = d
      .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all();
    expect(rows.map((r: any) => r.version)).toEqual(["20260519_001", "20260519_002"]);
  });
  it("is idempotent on re-run", () => {
    const d = db();
    const migs = [{ version: "20260519_001", sql: "CREATE TABLE a(x);" }];
    expect(runMigrations(d, migs)).toEqual(["20260519_001"]);
    expect(runMigrations(d, migs)).toEqual([]);
  });
  it("throws conflict on checksum drift", () => {
    const d = db();
    runMigrations(d, [{ version: "20260519_001", sql: "CREATE TABLE a(x);" }]);
    try {
      runMigrations(d, [{ version: "20260519_001", sql: "CREATE TABLE a(x, y);" }]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("conflict");
    }
  });
  it("rolls back a failing migration", () => {
    const d = db();
    expect(() =>
      runMigrations(d, [
        { version: "20260519_001", sql: "CREATE TABLE ok(x); CREATE TABLE oops(" },
      ]),
    ).toThrow();
    const rows = d.prepare("SELECT count(*) c FROM schema_migrations").get();
    expect(rows.c).toBe(0);
  });
});
