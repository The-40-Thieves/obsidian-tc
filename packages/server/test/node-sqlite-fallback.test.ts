import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openNodeSqlite } from "../src/db/node-node-sqlite";

describe("THE-276 node:sqlite fallback adapter", () => {
  const dir = mkdtempSync(join(tmpdir(), "otc-ns-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
});
