// THE-694/695 — the permitted-path set. Path-keyed, not chunk-keyed: readableRel is a pure
// function of the path, so the live vault needs 1,146 rows rather than 13,486.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import {
  DEFAULT_MAX_SETS,
  type EnsureAclPathSetOpts,
  ensureAclPathSet,
  evictAclPathSets,
} from "../src/search/acl_path_set";
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

const members = (db: Database, setId: number): string[] =>
  (
    db
      .prepare("SELECT path FROM acl_path_members WHERE set_id = ? ORDER BY path")
      .all(setId) as Array<{ path: string }>
  ).map((r) => r.path);

const build = (db: Database, over: Partial<EnsureAclPathSetOpts> = {}): number | null =>
  ensureAclPathSet(db, {
    vaultId: "main",
    aclFingerprint: "fp-a",
    generation: 1,
    allPaths: () => ["02-projects/a.md", "09-secret/b.md", "02-projects/c.md"],
    isReadable: (p) => p.startsWith("02-projects/"),
    nowMs: 1000,
    ...over,
  });

describe("ensureAclPathSet", () => {
  it("materializes only the readable paths", () => {
    const db = cacheDb();
    const id = build(db);
    expect(id).not.toBeNull();
    expect(members(db, id as number)).toStrictEqual(["02-projects/a.md", "02-projects/c.md"]);
    db.close?.();
  });

  it("reuses the set when the generation is unchanged", () => {
    const db = cacheDb();
    const first = build(db);
    let calls = 0;
    const second = build(db, {
      allPaths: () => {
        calls++;
        return [];
      },
    });
    expect(second).toBe(first);
    expect(calls).toBe(0); // a hit must not touch the universe at all — that read is the cost
    db.close?.();
  });

  it("rebuilds in place on a generation bump, keeping the same set_id", () => {
    const db = cacheDb();
    const first = build(db);
    const second = build(db, {
      generation: 2,
      allPaths: () => ["02-projects/a.md", "02-projects/new.md"],
      isReadable: () => true,
    });
    expect(second).toBe(first); // same surrogate id — members replaced, not accumulated
    expect(members(db, second as number)).toStrictEqual(["02-projects/a.md", "02-projects/new.md"]);
    db.close?.();
  });

  it("REFUSES to persist an empty set over a non-empty universe", () => {
    const db = cacheDb();
    // The trap this guards: a broken universe query materializes an empty set, every query then
    // filters to nothing, and the system looks perfectly healthy while returning zero results.
    const id = build(db, { isReadable: () => false });
    expect(id).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM acl_path_sets").get()).toMatchObject({ n: 0 });
    db.close?.();
  });

  it("returns null rather than throwing when the tables are absent", () => {
    const db = openMemoryDb(); // no migrations at all — the pre-migration cache.db case
    expect(build(db)).toBeNull();
    db.close?.();
  });

  it("isolates fingerprints over the same vault", () => {
    const db = cacheDb();
    const a = build(db, {
      aclFingerprint: "fp-a",
      isReadable: (p) => p.startsWith("02-projects/"),
    });
    const b = build(db, { aclFingerprint: "fp-b", isReadable: (p) => p.startsWith("09-secret/") });
    expect(a).not.toBe(b);
    expect(members(db, a as number)).toStrictEqual(["02-projects/a.md", "02-projects/c.md"]);
    expect(members(db, b as number)).toStrictEqual(["09-secret/b.md"]);
    db.close?.();
  });
});

describe("evictAclPathSets — the rowid-reuse leak", () => {
  it("leaves no member reachable under a REUSED set_id, without relying on the FK pragma", () => {
    const db = cacheDb();
    // The failing condition this test exists for. foreign_keys is per-connection runtime state, so
    // a raw connection would silently lose the cascade — eviction must be correct without it.
    db.exec("PRAGMA foreign_keys = OFF");

    // `b` is inserted FIRST (so it holds the smaller id) but built EARLIER, and `a` is newer. The
    // LRU drop therefore takes `b`. The assertion below covers orphans under ANY id, so the test
    // cannot pass by accident of which row was evicted.
    const b = build(db, {
      aclFingerprint: "fp-b",
      nowMs: 1000,
      allPaths: () => ["09-secret/b.md"],
      isReadable: () => true,
    }) as number;
    const a = build(db, { aclFingerprint: "fp-a", nowMs: 2000 }) as number;
    expect(b).toBeLessThan(a);

    expect(evictAclPathSets(db, 1)).toBe(1);

    expect(members(db, b)).toStrictEqual([]);
    // Zero orphans by construction: any member row whose set is gone is a row a REUSED set_id
    // would serve to a different principal.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM acl_path_members WHERE set_id NOT IN (SELECT set_id FROM acl_path_sets)",
        )
        .get(),
    ).toMatchObject({ n: 0 });
    db.close?.();
  });

  it("evicts least-recently-built sets beyond the cap, members first", () => {
    const db = cacheDb();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        build(db, {
          aclFingerprint: `fp-${i}`,
          nowMs: 1000 + i,
          allPaths: () => [`02-projects/${i}.md`],
          isReadable: () => true,
        }) as number,
      );
    }
    expect(evictAclPathSets(db, 2)).toBe(2);
    const left = (
      db.prepare("SELECT set_id FROM acl_path_sets ORDER BY set_id").all() as Array<{
        set_id: number;
      }>
    ).map((r) => r.set_id);
    expect(left).toStrictEqual([ids[2], ids[3]]); // the two most recently built survive
    expect(members(db, ids[0] as number)).toStrictEqual([]);
    expect(members(db, ids[1] as number)).toStrictEqual([]);
    db.close?.();
  });

  it("exposes a default cap", () => {
    expect(DEFAULT_MAX_SETS).toBe(32);
  });
});
