import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

describe("20260724_001 plane vault_id migration", () => {
  it("adds vault_id to contradictions and re-scopes the dedup index", () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const cols = (db.prepare("PRAGMA table_info(contradictions)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("vault_id");
    const idx = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_contradictions_pair'",
      )
      .get() as { sql: string };
    expect(idx.sql).toContain("vault_id");
  });

  it("rebuilds syntheses with vault_id in the primary key", () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const pk = (db.prepare("PRAGMA table_info(syntheses)").all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(["vault_id", "iso_year", "iso_week"]);
  });

  it("two vaults can hold the same synthesis week and the same contradiction sha-pair", () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const insSyn = db.prepare(
      "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns) VALUES (?, 2026, 30, 0, 0, 0, '[]', '[]')",
    );
    insSyn.run("v1");
    expect(() => insSyn.run("v2")).not.toThrow();
    const insCtr = db.prepare(
      "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, status, detected_at) VALUES (?, ?, 'sc', 'a.md', 'cc', 'b.md', 'sha1', 'sha2', 'tension', 'open', 0)",
    );
    insCtr.run("v1_pair", "v1");
    expect(() => insCtr.run("v2_pair", "v2")).not.toThrow();
  });
});
