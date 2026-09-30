// Child process for migrate-cold-boot-race.test.ts: one of N real processes cold-booting the same
// chain against the same fresh cacheDir. Under Bun (bun:sqlite), like ratelimit-child.ts; the
// parent is Node. It imports everything first, prints READY, then blocks on ONE line of stdin so
// the parent can release all N at once — without that barrier the spawns stagger by tens of ms
// (longer than a whole chain takes to apply) and never actually overlap.
// Prints one JSON line: {ok:true, applied:[...versions this process applied]} or {ok:false, error}.
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../../src/db/migration-manifest";
import { embeddedSql } from "../../src/db/migrations-embedded";
import { openDatabase } from "../../src/db/open";
import { provisionAuthDb, provisionCacheDb } from "../../src/db/provision";

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
  console.log(
    JSON.stringify({
      ok: false,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
    }),
  );
}
process.exit(0);
