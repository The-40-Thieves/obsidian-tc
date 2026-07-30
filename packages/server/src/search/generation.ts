// THE-496 — the per-vault generation counter (query-cache prerequisite).
//
// A monotonic version per vault, bumped on every content mutation that can change query results. It
// is one half of the query-cache key (THE-497); the ACL fingerprint (acl.ts) is the other. The bump
// lives INSIDE each index write transaction so a mutation and its generation change commit atomically
// — a missed bump would silently serve stale cached results, and over-bumping is merely a cache miss
// (safe), so the design errs toward bumping.
//
// THE-579 — who bumps, and the one writer that deliberately does not:
//
//   * indexing/index-vault.ts (indexVault) + indexing/index-note.ts (indexNote / deindexNote),
//     re-exported from indexer.ts — authored content. The original three sites.
//   * derived-edges.ts (reconcileDerivedEdges / …Scoped) — the DERIVED plane: similar_to, shared_tag
//     and semantically_similar_to. The graph-expansion stage walks these when densify.includeInWalk
//     is on, and `confidence` is the weight fusion reads, so rewriting them changes results. Bumps
//     only when a row was actually inserted, deleted, or had its VALUES changed — an idempotent
//     re-run stays a true no-op rather than churning the cache on every densify pass.
//   * cluster.ts (assignClusters) — chunks.cluster_id, read by maxPerCluster diversification.
//
//   * NOT the activation recompute (experiential/activation.ts), and this is deliberate rather than
//     an oversight. `cached_activation_score` lives in vault_object_state in experiential.db — a
//     PHYSICALLY separate store with no cross-file FK and no vault_id column (ADR-0004, the
//     membrane). recomputeActivation() receives only that db, so bumping cache.db's counter from
//     there means crossing the membrane and inventing a chunk→vault mapping; that is a design
//     decision, not a missing line. Bounded in the meantime: activation is off by default and shifts
//     a result by at most one position, and THE-497's required TTL still covers it.

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
