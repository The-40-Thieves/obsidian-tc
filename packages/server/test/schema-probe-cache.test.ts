// THE-491 item 1: the schema-shape probes ran `PRAGMA table_info(...)` on every call.
// hasBodyShaColumn is invoked per note during indexing and again per reconcile pass, so a
// 1000-note vault paid 1000+ PRAGMA round trips to answer a question whose answer only changes at
// migration time.
//
// The repo already had the right pattern one file over — fts.ts caches tableExists in a
// WeakMap<Database, boolean>, keyed per connection so a closed db's entry is collectable.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { hasBodyShaColumn, hasDerivedEdgeColumns } from "../src/search/indexer";
import { openMemoryDb } from "./helpers";

/** Wrap a db so PRAGMA table_info prepares can be counted without changing behaviour. */
function countingDb(db: Database): { db: Database; pragmas: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (/PRAGMA\s+table_info/i.test(sql)) n += 1;
          return (target as Database).prepare(sql);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as Database;
  return { db: proxy, pragmas: () => n };
}

describe("THE-491 schema-probe memoization", () => {
  it("hasBodyShaColumn issues the PRAGMA once per connection, not once per call", () => {
    const base = openMemoryDb();
    provisionCacheDb(base);
    const { db, pragmas } = countingDb(base);

    const first = hasBodyShaColumn(db);
    for (let i = 0; i < 50; i++) hasBodyShaColumn(db);

    expect(first).toBe(true); // the column exists post-migration
    expect(pragmas()).toBe(1);
  });

  it("hasDerivedEdgeColumns issues the PRAGMA once per connection", () => {
    const base = openMemoryDb();
    provisionCacheDb(base);
    const { db, pragmas } = countingDb(base);

    const first = hasDerivedEdgeColumns(db);
    for (let i = 0; i < 50; i++) hasDerivedEdgeColumns(db);

    expect(first).toBe(true);
    expect(pragmas()).toBe(1);
  });

  it("caches per connection — a second db is probed independently", () => {
    const a = openMemoryDb();
    provisionCacheDb(a);
    const b = openMemoryDb();
    provisionCacheDb(b);
    const ca = countingDb(a);
    const cb = countingDb(b);

    hasBodyShaColumn(ca.db);
    hasBodyShaColumn(ca.db);
    hasBodyShaColumn(cb.db);

    // One PRAGMA each: the cache must not be a module-global that leaks across connections.
    expect(ca.pragmas()).toBe(1);
    expect(cb.pragmas()).toBe(1);
  });

  it("still reports false on a database that never had the column", () => {
    // A pre-migration cache.db: the probe must answer false and stay cached at false, so the
    // graceful-degrade path keeps working rather than crashing on a missing column.
    const base = openMemoryDb();
    base.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, vault_id TEXT)");
    const { db, pragmas } = countingDb(base);

    expect(hasBodyShaColumn(db)).toBe(false);
    expect(hasBodyShaColumn(db)).toBe(false);
    expect(pragmas()).toBe(1);
  });
});
