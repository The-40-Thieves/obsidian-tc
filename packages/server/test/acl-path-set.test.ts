// THE-694/695 — the permitted-path set. Path-keyed, not chunk-keyed: readableRel is a pure
// function of the path, so the live vault needs 1,146 rows rather than 13,486.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${file}`, import.meta.url)), "utf8");
const CACHE_CHAIN = CACHE_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));

function cacheDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, CACHE_CHAIN);
  return db;
}

describe("acl_path_sets schema", () => {
  it("provisions both tables through the production migration chain", () => {
    const db = cacheDb();
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'acl_path_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toStrictEqual(["acl_path_members", "acl_path_sets"]);
    db.close?.();
  });

  it("keys a set by (fingerprint, vault) so a regenerated set replaces rather than accumulates", () => {
    const db = cacheDb();
    db.prepare(
      "INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count) VALUES ('fp','main',1,1,1)",
    ).run();
    // A second row for the same (fingerprint, vault) must be refused — growth is bounded by
    // distinct fingerprints, never by generations.
    expect(() =>
      db
        .prepare(
          "INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count) VALUES ('fp','main',2,2,1)",
        )
        .run(),
    ).toThrow();
    db.close?.();
  });
});
