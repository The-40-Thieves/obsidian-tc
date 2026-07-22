// THE-502: the dedup copy path looks chunks up by (vault_id, body_sha, content_hash), but the
// schema only indexed body_sha. On a vault with many duplicate bodies — templates, canonical notes,
// the exact case cross-path dedup exists for — SQLite had to filter vault_id and content_hash by
// scanning every row sharing a body_sha.
//
// Asserting the QUERY PLAN rather than a timing: a wall-clock assertion on an index is flaky and
// proves nothing about which access path was chosen. If a future schema change makes the planner
// prefer something else, this fails loudly instead of silently regressing to a scan.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

/** The exact predicate copyDedupVectors issues (indexer.ts). */
const DEDUP_LOOKUP = `
  SELECT e.embedding AS embedding, e.dimensions AS dimensions
  FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
  WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ?
    AND e.model = ? AND e.is_active = 1 AND c.id != ? LIMIT 1`;

function plan(sql: string): string {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: string }>;
  return rows.map((r) => r.detail ?? "").join(" | ");
}

describe("THE-502 dedup index", () => {
  it("the composite index exists after provisioning", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chunks_dedup'")
      .get() as { name: string } | undefined;

    expect(idx?.name).toBe("idx_chunks_dedup");
  });

  it("the planner uses it for the dedup lookup instead of scanning chunks", () => {
    const detail = plan(DEDUP_LOOKUP);

    expect(detail).toContain("idx_chunks_dedup");
    // A full scan of chunks is precisely what the index exists to prevent.
    expect(detail).not.toMatch(/SCAN c\b/);
  });

  it("covers all three predicate columns, not just the leading one", () => {
    // A single-column body_sha index would also "be used" — the point is that vault_id and
    // content_hash are resolved by the index too, so the assertion names all three.
    const db = openMemoryDb();
    provisionCacheDb(db);

    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_chunks_dedup'")
        .get() as { sql: string }
    ).sql;

    for (const col of ["vault_id", "body_sha", "content_hash"]) expect(sql).toContain(col);
  });
});
