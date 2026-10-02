// The bun:sqlite adapter's `close()` must really close the connection, not just request it.
//
// bun:sqlite's `db.close()` is `sqlite3_close_v2`: with a prepared statement still outstanding (the
// adapter's `prepareCached` keeps them for the life of the connection) the connection becomes a
// zombie that keeps every lock it held until the statements are garbage-collected or the process
// ends. `db.close(true)` finalizes them first. On Windows a process's locks are released lazily
// when it terminates, so sibling servers booting against the same cache directory saw SQLITE_BUSY on
// CREATE TABLE / BEGIN IMMEDIATE for seconds after one of them shut down (the merge-queue failure of
// migrate-cold-boot-race.test.ts); closing the connection for real releases them while the process
// is still alive.
//
// The observable difference, on every platform: SQLite deletes `-wal`/`-shm` when the LAST
// connection to the file closes, and only a real close counts.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { makeTempDir, rmTemp } from "./tmp";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "db-close-child.ts");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmTemp(d);
});

describe.skipIf(!bunAvailable)("bun:sqlite adapter close()", () => {
  it("really closes the connection even with a prepared statement outstanding", () => {
    const dir = makeTempDir("otc-bun-close-");
    tmpDirs.push(dir);
    const r = spawnSync("bun", [CHILD, join(dir, "close.db")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("{"));
    expect(JSON.parse(line ?? "{}")).toEqual({ wal: false, shm: false });
  });
});

// The same observable for the adapter this (Node) process picks, so the two Node adapters stay held
// to the contract the Bun one was fixed for: close() finalizes outstanding statements, then closes.
describe.skipIf(typeof (globalThis as { Bun?: unknown }).Bun !== "undefined")(
  "node adapter close()",
  () => {
    it("really closes the connection even with a prepared statement outstanding", async () => {
      const dir = makeTempDir("otc-node-close-");
      tmpDirs.push(dir);
      const path = join(dir, "close.db");
      const db = await openDatabase(path, 1000);
      db.exec("CREATE TABLE t (x INTEGER)");
      db.exec("INSERT INTO t VALUES (1)");
      const st = db.prepareCached
        ? db.prepareCached("SELECT x FROM t WHERE x = ?")
        : db.prepare("SELECT x FROM t WHERE x = ?");
      st.get(1);
      db.close?.();
      expect({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) }).toEqual({
        wal: false,
        shm: false,
      });
    });
  },
);
