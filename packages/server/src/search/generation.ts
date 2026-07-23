// THE-496 — the per-vault generation counter (query-cache prerequisite).
//
// A monotonic version per vault, bumped on every content mutation that can change query results. It
// is one half of the query-cache key (THE-497); the ACL fingerprint (acl.ts) is the other. The bump
// lives INSIDE each index write transaction so a mutation and its generation change commit atomically
// — a missed bump would silently serve stale cached results, and over-bumping is merely a cache miss
// (safe), so the design errs toward bumping.

import { tableExists } from "../db/introspect";
import { cachedPrepare, type Database } from "../db/types";

/** True when the vault_generation table exists (a pre-migration cache.db lacks it). */
export function hasVaultGeneration(db: Database): boolean {
  return tableExists(db, "vault_generation");
}

/**
 * Bump a vault's generation by one and return the new value. No-op (returns 0) on a pre-migration db
 * so the index write path never breaks when the table is absent. Call this WITHIN the write
 * transaction that made the mutation.
 */
export function bumpGeneration(db: Database, vaultId: string): number {
  if (!hasVaultGeneration(db)) return 0;
  cachedPrepare(
    db,
    "INSERT INTO vault_generation (vault_id, generation) VALUES (?, 1) ON CONFLICT(vault_id) DO UPDATE SET generation = generation + 1",
  ).run(vaultId);
  return readGeneration(db, vaultId);
}

/** Read a vault's current generation (0 when never bumped or the table is absent). A cheap PK read
 *  for the query-cache hot path. */
export function readGeneration(db: Database, vaultId: string): number {
  if (!hasVaultGeneration(db)) return 0;
  const row = cachedPrepare(db, "SELECT generation FROM vault_generation WHERE vault_id = ?").get(
    vaultId,
  ) as { generation: number } | undefined;
  return row?.generation ?? 0;
}
