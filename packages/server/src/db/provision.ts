// THE single source of truth for the cache.db schema.
//
// It did not have one. Production hand-assembled a migration chain inside cli.ts (a readFileSync per
// migration, then one inline runMigrations call), while 35 test files provisioned from src/schema.sql —
// a file production NEVER executes, and which duplicated ten tables from 20260519_001_initial.sql.
//
// So the tests built a database production never builds, and the difference was invisible: every table
// introduced by a migration (notes, vault_edges, plane, snapshots...) was simply ABSENT under test. Code
// guarded by `if (tableExists(db, "vault_edges"))` therefore no-opped silently — the edge-reconcile block
// never executed in five of the six indexVault tests, and one test asserted on a builder that was never
// called and passed anyway. A schema only the tests use is not a schema; it is a second, drifting
// implementation with nobody checking it against the first.
//
// Both paths now provision through this chain. Divergence is no longer possible.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Migration, runMigrations } from "./migrate";
import type { Database } from "./types";

// The migration SQL sits at src/migrations in source and dist/migrations in the bundle. This module
// is at src/db/, so ../migrations resolves under the from-source runtime (vitest, bun-from-src), but
// bun build collapses import.meta.url to the bundle ENTRY (dist/cli.js), where the assets live at
// ./migrations. Resolve whichever actually exists so both the test runtime and the shipped CLI work.
const MIGRATIONS_DIR = existsSync(fileURLToPath(new URL("../migrations/", import.meta.url)))
  ? new URL("../migrations/", import.meta.url)
  : new URL("./migrations/", import.meta.url);

const sql = (file: string): string =>
  readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8");

/**
 * The cache.db migration chain, in application order.
 *
 * The experiential tier is deliberately NOT here: it is a physically separate store (db/experiential.ts)
 * so low-trust per-retrieval state cannot FK into the authored atoms, and a reset is a file truncate.
 * Its migrations live in their own chain, still assembled in cli.ts.
 */
export const CACHE_MIGRATIONS: Migration[] = [
  { version: "20260519_001", sql: sql("20260519_001_initial.sql") },
  { version: "20260519_002", sql: sql("20260519_002_entity_unique.sql") },
  { version: "20260626_001", sql: sql("20260626_001_vault_edges.sql") },
  { version: "20260626_002", sql: sql("20260626_002_plane.sql") },
  { version: "20260702_001", sql: sql("20260702_001_notes.sql") },
  { version: "20260703_001", sql: sql("20260703_001_vault_edges_vault_id.sql") },
  { version: "20260709_001", sql: sql("20260709_001_snapshots.sql") },
  { version: "20260713_001", sql: sql("20260713_001_vault_edges_derived.sql") },
];

/** Bring a cache.db up to the current schema. The only way anything should provision one. */
export function provisionCacheDb(
  db: Database,
  opts: { version?: string; now?: () => number } = {},
): string[] {
  return runMigrations(db, CACHE_MIGRATIONS, opts);
}
