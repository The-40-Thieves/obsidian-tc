// GH #1160: ensureVecChunks' backfill used to report only a skipped-vector COUNT inside an ordinary
// "rebuilding vec_chunks" line. A rebuild that put 0 of 16,882 active embeddings into the dense index
// read exactly like a healthy one. This classifies a backfill that left the index empty or mostly
// empty and says what the active rows actually look like, so the cause (another width/model, or a
// chunk with more than one active embedding) is in the log instead of being a debugging session.
import type { Database } from "../db/types";

export interface BackfillShortfall {
  /** Active embeddings (joined to a chunk) at the time of the rebuild. */
  active: number;
  /** Rows the backfill put in vec_chunks. */
  inserted: number;
  /** Chunks carrying more than one active embedding (should be impossible after 20261008_001). */
  multiActiveChunks: number;
  /** Where the active rows actually are, largest first: `model @ width: count`. */
  breakdown: string[];
}

/** Undefined when the backfill is healthy: nothing active, or at least half of it landed and no
 *  chunk is double-active. A mid-swap rebuild (everything still at the old model) IS reported —
 *  dense retrieval really is empty until the re-embed — and that is the point. */
export function backfillShortfall(
  db: Database,
  active: number,
  inserted: number,
): BackfillShortfall | undefined {
  if (active <= 0) return undefined;
  const multi = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT e.chunk_id FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
            WHERE e.is_active = 1 GROUP BY e.chunk_id HAVING COUNT(*) > 1)`,
      )
      .get() as { n: number }
  ).n;
  if (inserted * 2 >= active && multi === 0) return undefined;
  const rows = db
    .prepare(
      `SELECT e.model AS model, length(e.embedding) / 4 AS width, COUNT(*) AS n
         FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
        WHERE e.is_active = 1 GROUP BY e.model, width ORDER BY n DESC, e.model LIMIT 5`,
    )
    .all() as Array<{ model: string; width: number; n: number }>;
  return {
    active,
    inserted,
    multiActiveChunks: multi,
    breakdown: rows.map((r) => `${r.model} @ ${r.width}: ${r.n}`),
  };
}

export function formatBackfillShortfall(s: BackfillShortfall, dims: number, model: string): string {
  const cause =
    s.multiActiveChunks > 0
      ? `${s.multiActiveChunks} chunk(s) carry MORE THAN ONE active embedding, so the model the ` +
        `backfill filters on is ambiguous — run \`obsidian-tc doctor\``
      : `the active embeddings are at another width/model than ${model} @ ${dims} (a model or ` +
        `dimension change not yet re-embedded?) — dense retrieval is degraded until they are re-embedded`;
  return (
    `[vec] WARNING: vec_chunks was rebuilt with ${s.inserted} of ${s.active} active embedding(s). ` +
    `Active rows are at: ${s.breakdown.join("; ")}. Likely cause: ${cause}.\n`
  );
}
