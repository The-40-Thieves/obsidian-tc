import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { loadVec } from "../src/search/vec";
import { makeTempDir, rmTemp } from "./tmp";

describe("THE-276 node:sqlite fallback adapter", () => {
  const dir = makeTempDir("otc-ns-");
  afterAll(() => rmTemp(dir));

  it("implements the Database interface over the built-in node:sqlite", async () => {
    const db = await openNodeSqlite(join(dir, "t.db"));
    db.exec("CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, n) VALUES (?, ?)");
    expect(ins.run("a", 1).changes).toBe(1);
    expect(db.prepare("SELECT n FROM t WHERE id = ?").get("a")).toEqual({ n: 1 });
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ id: "a", n: 1 }]);
    // The WAL pragma is applied on the real file db.
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    // prepareCached memoizes by SQL text.
    expect(db.prepareCached?.("SELECT 1 AS x")).toBe(db.prepareCached?.("SELECT 1 AS x"));
    db.close?.();
  });

  // The packed .mcpb ships sqlite-vec but no better-sqlite3, so this adapter is the one that must
  // load it there (the first-run matrix's mcpb cells measure vec=on).
  it("loads sqlite-vec through loadExtension and leaves SQL load_extension() disabled", async () => {
    const db = await openNodeSqlite(join(dir, "vec.db"));
    expect(typeof db.loadExtension).toBe("function");
    expect(loadVec(db)).toBe(true);
    expect((db.prepare("SELECT vec_version() AS v").get() as { v: string }).v).toMatch(/^v/);
    expect(() => db.prepare("SELECT load_extension('nope')").get()).toThrow();
    db.close?.();
  });
});
