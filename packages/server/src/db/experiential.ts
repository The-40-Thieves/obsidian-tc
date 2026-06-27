import { join } from "node:path";
import { type Migration, runMigrations } from "./migrate";
import { openDatabase } from "./open";
import type { Database } from "./types";

export interface ProvisionExperientialOptions {
  version?: string;
  now?: () => number;
  /** Override the DB opener; tests inject an in-memory Database. */
  open?: (path: string) => Promise<Database>;
}

/**
 * Provision the experiential tier as a PHYSICALLY SEPARATE store -- the membrane.
 *
 * Opens `<cacheDir>/experiential.db` and applies its own forward-only, idempotent
 * migration chain (separate from cache.db's). The experiential store holds low-trust
 * per-retrieval state (engram activation history, retrieval feedback) in its own file so
 * it can never FK into the authored atoms in cache.db, poisoning blast radius is capped at
 * the store boundary, and a reset is a file truncate.
 *
 * THE-233 W-SCHEMA provisions schema only: the write-on-gate controls and handle threading
 * arrive with the capture port (a later slice). Callers that only need the file + schema to
 * exist may release the returned handle immediately.
 */
export async function provisionExperientialDb(
  cacheDir: string,
  migrations: Migration[],
  opts: ProvisionExperientialOptions = {},
): Promise<Database> {
  const open = opts.open ?? openDatabase;
  const db = await open(join(cacheDir, "experiential.db"));
  runMigrations(db, migrations, { version: opts.version, now: opts.now });
  return db;
}
