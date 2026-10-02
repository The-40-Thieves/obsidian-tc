// Child for bun-sqlite-close.test.ts. Under Bun (bun:sqlite): open the real adapter, leave a prepared
// statement outstanding (as every long-lived server does: `prepareCached` keeps them for the life
// of the connection), close the adapter, and report which WAL sidecar files are still on disk.
// SQLite deletes `-wal`/`-shm` only when the LAST connection to the file truly closes, so a
// connection that is merely a zombie after `close()` leaves both behind.
import { existsSync } from "node:fs";
import { openDatabase } from "../../src/db/open";

const [path] = process.argv.slice(2) as [string];
const db = await openDatabase(path, 1000);
db.exec("CREATE TABLE t (x INTEGER)");
db.exec("INSERT INTO t VALUES (1)");
const st = db.prepareCached
  ? db.prepareCached("SELECT x FROM t WHERE x = ?")
  : db.prepare("SELECT x FROM t WHERE x = ?");
st.get(1);
db.close?.();
console.log(JSON.stringify({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) }));
