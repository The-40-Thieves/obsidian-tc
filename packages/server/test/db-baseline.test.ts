import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "../src/db/node-better-sqlite3";
import { cachedPrepare, type Database, type Statement } from "../src/db/types";

// better-sqlite3's native binding is not built in every local env (the suite otherwise uses
// node:sqlite); probe once and skip the adapter integration test when it cannot load. It runs on CI.
let bsqlOk = true;
try {
  const d = await openBetterSqlite3(":memory:");
  d.close?.();
} catch {
  bsqlOk = false;
}

describe("THE-273 cachedPrepare helper", () => {
  it("uses prepareCached when the adapter provides it, else falls back to prepare", () => {
    const stmt: Statement = { run: () => ({ changes: 0 }), get: () => null, all: () => [] };
    let prepCalls = 0;
    let cachedCalls = 0;
    const withCache: Database = {
      exec() {},
      prepare() {
        prepCalls++;
        return stmt;
      },
      prepareCached() {
        cachedCalls++;
        return stmt;
      },
    };
    cachedPrepare(withCache, "SELECT 1");
    expect(cachedCalls).toBe(1);
    expect(prepCalls).toBe(0);
    const noCache: Database = {
      exec() {},
      prepare() {
        prepCalls++;
        return stmt;
      },
    };
    cachedPrepare(noCache, "SELECT 1");
    expect(prepCalls).toBe(1);
  });
});

describe.skipIf(!bsqlOk)("THE-273 db adapter baseline + statement cache", () => {
  it("applies the PRAGMA baseline and memoizes prepared statements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "db-"));
    const db = await openBetterSqlite3(join(dir, "t.db"));
    expect((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    expect((db.prepare("PRAGMA cache_size").get() as { cache_size: number }).cache_size).toBe(
      -32000,
    );
    const a = db.prepareCached?.("SELECT 1 AS x");
    const b = db.prepareCached?.("SELECT 1 AS x");
    expect(a).toBe(b);
    expect((a?.get() as { x: number } | undefined)?.x).toBe(1);
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
});
