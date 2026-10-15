// Child for bun-sqlite-close.test.ts (GH #1259). Under Bun: commit a write through the real adapter,
// then close it while bun:sqlite's `close(true)` reports SQLITE_BUSY — the failure the note-quality
// CLI hit after its writes had committed, when other processes held the same cache.db open. The
// stand-in is a wrapper over Database.prototype.close: it performs the real close first (so the
// connection is genuinely released, as on the platform where the failure was seen) and then throws
// the busy- or other-class error the native call reports. Prints whatever the adapter's close threw.
import { Database } from "bun:sqlite";
import { openDatabase } from "../../src/db/open";

const [path, mode] = process.argv.slice(2) as [string, "busy" | "other"];
const proto = Database.prototype as unknown as { close: (throwOnError?: boolean) => void };
const realClose = proto.close;
proto.close = function (this: unknown, throwOnError?: boolean): void {
  realClose.call(this, false);
  if (!throwOnError) return;
  throw mode === "busy"
    ? Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 })
    : Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR", errno: 10 });
};

const db = await openDatabase(path, 1000);
db.exec("CREATE TABLE t (x INTEGER)");
db.exec("INSERT INTO t VALUES (1)");
let threw: string | null = null;
try {
  db.close?.();
} catch (e) {
  threw = (e as Error).message;
}
console.log(JSON.stringify({ threw }));
