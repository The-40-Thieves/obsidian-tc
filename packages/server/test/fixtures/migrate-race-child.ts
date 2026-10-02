// Child process for migrate-cold-boot-race.test.ts: one of N real processes cold-booting the same
// chain against the same fresh cacheDir. Under Bun (bun:sqlite), like ratelimit-child.ts; the
// parent is Node. It imports everything first, prints READY, then blocks on ONE line of stdin so
// the parent can release all N at once — without that barrier the spawns stagger by tens of ms
// (longer than a whole chain takes to apply) and never actually overlap.
// Closes the adapter before exiting, as a server's shutdown does: leaving the connection open for
// the process to tear down is not what production does, and on Windows a terminating process's
// locks are released lazily, which would race the siblings on a timing the test does not control.
// Prints one JSON line: {ok:true, applied:[...versions this process applied], ms} or
// {ok:false, error, ms}; `ms` is the child's wall time since the barrier released it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../../src/db/migration-manifest";
import { embeddedSql } from "../../src/db/migrations-embedded";
import { openDatabase } from "../../src/db/open";
import { provisionAuthDb, provisionCacheDb } from "../../src/db/provision";
import type { Database } from "../../src/db/types";

/** A failure report a CI log can be read against: message, the SQLite result code(s) the adapter
 *  exposes (bun:sqlite sets `code` to the extended name, e.g. SQLITE_IOERR_SHMSIZE, and `errno` to
 *  the extended number), the pragma/statement that failed when the adapter annotated it, the db
 *  file's sidecar state, which child (`proc`) and phase failed, how long after the barrier it
 *  failed (a SQLITE_BUSY at ~busy_timeout means the busy handler spent its whole budget, one after
 *  a few ms means it was never invoked), and the stack. */
function describeFailure(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const o = e as Error & { code?: unknown; errno?: unknown; errcode?: unknown; pragma?: unknown };
  const sidecars = ["", "-wal", "-shm", "-journal"]
    .map((x) => `${x || "main"}=${existsSync(join(cacheDir, `${chain}.db${x}`))}`)
    .join(" ");
  return (
    `${e.message} [chain=${chain} proc=${procIndex} phase=${phase} elapsedMs=${elapsedMs()} pid=${process.pid} code=${String(o.code)} errno=${String(o.errno)} ` +
    `errcode=${String(o.errcode)} pragma=${String(o.pragma)} files: ${sidecars}]\n${e.stack}`
  );
}

const [chain, cacheDir, busyTimeoutMs, procIndex = "?"] = process.argv.slice(2) as [
  string,
  string,
  string,
  string?,
];
const busy = Number(busyTimeoutMs);
/** Where the child was when it failed: opening the file, or running the chain. */
let phase = "start";
let released = 0;
const elapsedMs = (): number => (released === 0 ? -1 : Math.round(performance.now() - released));

console.log("READY");
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => {
    released = performance.now();
    resolve();
  });
});

let db: Database | undefined;
function closeQuietly(): void {
  try {
    db?.close?.();
  } catch {
    // the migration outcome is what is being reported
  }
}

try {
  let applied: string[];
  phase = "open";
  db = await openDatabase(join(cacheDir, `${chain}.db`), busy);
  phase = "migrate";
  if (chain === "cache") {
    applied = provisionCacheDb(db);
  } else if (chain === "auth") {
    applied = provisionAuthDb(db);
  } else {
    applied = runMigrations(
      db,
      EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
        version: versionOf(file),
        sql: embeddedSql(file),
      })),
    );
  }
  closeQuietly();
  console.log(JSON.stringify({ ok: true, applied, ms: elapsedMs() }));
} catch (e) {
  closeQuietly();
  console.log(JSON.stringify({ ok: false, error: describeFailure(e), ms: elapsedMs() }));
}
process.exit(0);
