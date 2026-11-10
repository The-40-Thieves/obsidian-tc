// cache.db + experiential.db pair for the vault_identity resolver tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

const EXPERIENTIAL_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({
  version: versionOf(f),
  sql: readFileSync(fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)), "utf8"),
}));

export function identityStores(): { cacheDb: Database; edb: Database } {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const edb = openMemoryDb();
  runMigrations(edb, EXPERIENTIAL_CHAIN);
  return { cacheDb, edb };
}

/** Record `id` at the already-normalized `rootRealpath`, as a past boot would have. */
export function seedIdentity(db: Database, id: string, rootRealpath: string): void {
  db.prepare(
    "INSERT INTO vault_identity (vault_id, root_realpath, root_canonical, created_at, updated_at) VALUES (?, ?, 1, 0, 0)",
  ).run(id, rootRealpath);
}
