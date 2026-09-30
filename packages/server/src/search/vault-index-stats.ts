// ADR-0007 class (b): the measured, per-vault index statistics that retrieval-defaults.ts derives
// parameters from. Reuses what the index already records — `chunks`, `vault_edges` — rather than
// adding a stats table: every query below is one indexed COUNT scoped to a single vault
// (idx_chunks_vault_path, idx_vault_edges_vault), so computing on demand is cheap enough, and the
// result is cached against the vault generation (generation.ts), which every index write already
// bumps inside its own transaction. The cache is what keeps this off the query hot path; it is only
// ever read when `retrieval.derivedDefaults` is on, so the default-off path never runs a query here.
//
// A short TTL backs the generation check because `readGeneration` returns 0 on a pre-migration
// cache.db that lacks the vault_generation table — without it such a db would serve its first stats
// forever.

import type { Database } from "../db/types";
import { readGeneration } from "./generation";

export interface VaultIndexStats {
  vaultId: string;
  /** Rows in `chunks` for this vault. */
  chunkCount: number;
  /** Distinct note paths that own at least one chunk. */
  noteCount: number;
  /** Authored (edge_kind = 'literal') edges; derived similar_to/shared_tag edges are excluded so
   *  the figure describes the author's link structure, not the densify plane. */
  edgeCount: number;
  /** chunkCount / noteCount; 0 for an empty vault, never NaN. */
  avgChunksPerNote: number;
  /** edgeCount / noteCount (mean authored out-degree); 0 for an empty vault, never NaN. */
  edgesPerNote: number;
}

/** Upper bound on cache age when the generation does not move. */
const STATS_TTL_MS = 5 * 60_000;

interface CacheEntry {
  generation: number;
  at: number;
  stats: VaultIndexStats;
}

const cache = new WeakMap<Database, Map<string, CacheEntry>>();

/** Stats for one vault, or null when they cannot be measured (no `chunks` table). */
export function readVaultIndexStats(
  db: Database,
  vaultId: string,
  opts: { now?: () => number } = {},
): VaultIndexStats | null {
  const now = (opts.now ?? Date.now)();
  const generation = readGeneration(db, vaultId);
  let perDb = cache.get(db);
  const hit = perDb?.get(vaultId);
  if (hit && hit.generation === generation && now - hit.at < STATS_TTL_MS) return hit.stats;

  const stats = computeVaultIndexStats(db, vaultId);
  if (stats === null) return null;
  if (!perDb) {
    perDb = new Map();
    cache.set(db, perDb);
  }
  perDb.set(vaultId, { generation, at: now, stats });
  return stats;
}

function count(db: Database, sql: string, vaultId: string): number {
  const row = db.prepare(sql).get(vaultId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function computeVaultIndexStats(db: Database, vaultId: string): VaultIndexStats | null {
  let chunkCount: number;
  let noteCount: number;
  try {
    chunkCount = count(db, "SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?", vaultId);
    noteCount = count(
      db,
      "SELECT COUNT(DISTINCT path) AS n FROM chunks WHERE vault_id = ?",
      vaultId,
    );
  } catch {
    return null; // no chunks table: stats are MISSING, which is not the same as zero
  }
  let edgeCount = 0;
  try {
    edgeCount = count(
      db,
      "SELECT COUNT(*) AS n FROM vault_edges WHERE vault_id = ? AND edge_kind = 'literal'",
      vaultId,
    );
  } catch {
    // vault_edges absent (pre-GraphRAG db): no authored edges to count.
  }
  return {
    vaultId,
    chunkCount,
    noteCount,
    edgeCount,
    avgChunksPerNote: noteCount > 0 ? chunkCount / noteCount : 0,
    edgesPerNote: noteCount > 0 ? edgeCount / noteCount : 0,
  };
}
