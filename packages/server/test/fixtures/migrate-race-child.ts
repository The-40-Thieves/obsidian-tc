// Child process for migrate-cold-boot-race.test.ts: one of N real processes cold-booting the same
// chain against the same fresh cacheDir. Under Bun (bun:sqlite), like ratelimit-child.ts; the
// parent is Node. It imports everything first, prints READY, then blocks on ONE line of stdin so
// the parent can release all N at once — without that barrier the spawns stagger by tens of ms
// (longer than a whole chain takes to apply) and never actually overlap.
// Prints one JSON line: {ok:true, applied:[...versions this process applied]} or {ok:false, error}.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../../src/db/migration-manifest";
import { embeddedSql } from "../../src/db/migrations-embedded";
import { openDatabase } from "../../src/db/open";
import { provisionAuthDb, provisionCacheDb } from "../../src/db/provision";

/** A failure report a CI log can be read against: message, the SQLite result code(s) the adapter
 *  exposes (bun:sqlite sets `code` to the extended name, e.g. SQLITE_IOERR_SHMSIZE, and `errno` to
 *  the extended number), the pragma/statement that failed when the adapter annotated it, the db
 *  file's sidecar state, and the stack. */
function describeFailure(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const o = e as Error & { code?: unknown; errno?: unknown; errcode?: unknown; pragma?: unknown };
  const sidecars = ["", "-wal", "-shm", "-journal"]
    .map((x) => `${x || "main"}=${existsSync(join(cacheDir, `${chain}.db${x}`))}`)
    .join(" ");
  return (
    `${e.message} [chain=${chain} pid=${process.pid} code=${String(o.code)} errno=${String(o.errno)} ` +
    `errcode=${String(o.errcode)} pragma=${String(o.pragma)} files: ${sidecars}]\n${e.stack}`
  );
}

const [chain, cacheDir, busyTimeoutMs] = process.argv.slice(2) as [string, string, string];
const busy = Number(busyTimeoutMs);

console.log("READY");
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
});

try {
  let applied: string[];
  if (chain === "cache") {
    const db = await openDatabase(join(cacheDir, "cache.db"), busy);
    applied = provisionCacheDb(db);
  } else if (chain === "auth") {
    const db = await openDatabase(join(cacheDir, "auth.db"), busy);
    applied = provisionAuthDb(db);
  } else {
    const db = await openDatabase(join(cacheDir, "experiential.db"), busy);
    applied = runMigrations(
      db,
      EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
        version: versionOf(file),
        sql: embeddedSql(file),
      })),
    );
  }
  console.log(JSON.stringify({ ok: true, applied }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: describeFailure(e) }));
}
process.exit(0);
