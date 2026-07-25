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
import { type Migration, runMigrations } from "./migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "./migration-manifest";
import { embeddedSql } from "./migrations-embedded";
import type { Database } from "./types";

// THE-578: the SQL is INLINED (db/migrations-embedded.ts, generated) rather than read from disk.
//
// This used to resolve `../migrations/` or `./migrations/` against import.meta.url, picking
// whichever existed so that both the from-source runtime and the dist bundle worked. It did — and
// it was still broken in the STANDALONE BINARIES, which is the case neither branch covers:
// `bun build --compile` freezes import.meta.url to the BUILD-TIME path and embeds no .sql files, so
// every published binary died at module load with
//   ENOENT ... '/home/runner/work/obsidian-tc/obsidian-tc/packages/server/src/db/migrations/...'
// against the CI runner's directory. Not even `--version` survived, since this module's top-level
// CACHE_MIGRATIONS runs before any argument parsing. v1.10.0 and v1.11.0 were both affected.
//
// The existsSync ternary is what made it look handled: two candidate paths, both resolved from the
// same frozen base, so neither could ever exist on a user's machine. A fallback that cannot fire is
// not a fallback.
//
// Inlining removes the filesystem from provisioning entirely, so there is ONE code path across
// vitest, `bun run`, the npm dist build and --compile. Bun's own `with { type: "text" }` would be
// the idiomatic embed, but vitest's rollup parser rejects that import attribute outright, and a
// generated .ts module is understood by every runtime here. Drift-gated by
// `bun run migrations:embed:check`.

/**
 * The cache.db migration chain, in application order.
 *
 * The experiential tier is deliberately NOT here: it is a physically separate store (db/experiential.ts)
 * so low-trust per-retrieval state cannot FK into the authored atoms, and a reset is a file truncate.
 * Its migrations live in their own chain, still assembled in cli.ts.
 */
export const CACHE_MIGRATIONS: Migration[] = CACHE_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: embeddedSql(file),
}));

/** Bring a cache.db up to the current schema. The only way anything should provision one. */
export function provisionCacheDb(
  db: Database,
  opts: { version?: string; now?: () => number } = {},
): string[] {
  return runMigrations(db, CACHE_MIGRATIONS, opts);
}
