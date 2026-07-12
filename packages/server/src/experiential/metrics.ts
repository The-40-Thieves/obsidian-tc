// THE-46 (local re-scope, 2026-07-11 flywheel decision) — the cycle-level knowledge-health
// scorecard, computed on demand from the derive layer (THE-44's chunk_access_stats view over
// chunk_retrievals) plus the authored store. No standing infra: the cycle-close session runs
// `obsidian-tc metrics` and stamps the result into a vault note (09-reference/metrics/); this
// module is the machine-readable half. Retrieval-quality numbers (nDCG/recall) come from the
// golden-set eval harness, not runtime — the cycle-close session merges them into the note.
import type { Database } from "../db/types";

export interface VaultMetrics {
  window: { since: number | null; until: number | null };
  totals: {
    chunks: number;
    notes: number;
    new_chunks: number;
    retrievals: number;
    citations: number;
  };
  access: {
    chunks_accessed: number;
    notes_accessed: number;
    stale_chunks: number;
    never_accessed_chunks: number;
  };
  linked: { notes_with_linear: number; distinct_issues: number };
  surfaces: Array<{ surface: string; retrievals: number }>;
  top_notes: Array<{ path: string; access_count: number; citations: number }>;
}

export function vaultMetrics(
  edb: Database,
  cacheDb: Database,
  opts: {
    vaultId: string;
    since?: number;
    until?: number;
    staleDays?: number;
    nowMs: number;
    topN?: number;
  },
): VaultMetrics {
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const staleMs = (opts.staleDays ?? 30) * 86_400_000;
  const staleBefore = opts.nowMs - staleMs;

  const one = (db: Database, sql: string, ...args: unknown[]): number =>
    ((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0) as number;

  const chunks = one(cacheDb, "SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?", opts.vaultId);
  const notes = one(cacheDb, "SELECT COUNT(*) AS n FROM notes WHERE vault_id = ?", opts.vaultId);
  const newChunks =
    since !== null
      ? one(
          cacheDb,
          "SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND created_at >= ? AND created_at <= ?",
          opts.vaultId,
          since,
          until ?? opts.nowMs,
        )
      : 0;

  // Window filter for retrieval-event counts; the access/staleness cuts below use all-time
  // stats (staleness is about the last touch ever, not the last touch this window).
  const wWhere = `${since !== null ? " AND retrieved_at >= ?" : ""}${until !== null ? " AND retrieved_at <= ?" : ""}`;
  const wArgs = [
    ...(since !== null ? [since] : []),
    ...(until !== null ? [until] : []),
  ] as unknown[];
  const retrievals = one(
    edb,
    `SELECT COUNT(*) AS n FROM chunk_retrievals WHERE 1=1${wWhere}`,
    ...wArgs,
  );
  const citations = one(
    edb,
    `SELECT COUNT(*) AS n FROM chunk_retrievals WHERE cited_in_response = 1${wWhere}`,
    ...wArgs,
  );

  const stats = edb
    .prepare("SELECT chunk_id, access_count, last_accessed_at, citations FROM chunk_access_stats")
    .all() as Array<{
    chunk_id: string;
    access_count: number;
    last_accessed_at: number;
    citations: number;
  }>;
  const statById = new Map(stats.map((s) => [s.chunk_id, s]));

  // chunk -> path via the authored store, batched (the two stores are separate files).
  const pathById = new Map<string, string>();
  const ids = [...statById.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const rows = cacheDb
      .prepare(
        `SELECT id, path FROM chunks WHERE vault_id = ? AND id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(opts.vaultId, ...batch) as Array<{ id: string; path: string }>;
    for (const r of rows) pathById.set(r.id, r.path);
  }

  let chunksAccessed = 0;
  let staleAccessed = 0;
  const noteAgg = new Map<string, { access_count: number; citations: number }>();
  for (const s of stats) {
    const path = pathById.get(s.chunk_id);
    if (path === undefined) continue; // deleted/foreign-vault chunks don't count
    chunksAccessed++;
    if (s.last_accessed_at < staleBefore) staleAccessed++;
    const agg = noteAgg.get(path) ?? { access_count: 0, citations: 0 };
    agg.access_count += s.access_count;
    agg.citations += s.citations;
    noteAgg.set(path, agg);
  }
  const neverAccessed = Math.max(0, chunks - chunksAccessed);
  // Stale = never touched, or last touched before the horizon.
  const staleChunks = neverAccessed + staleAccessed;

  const linkedRows = cacheDb
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT json_extract(frontmatter, '$.linear')) AS d
       FROM notes WHERE vault_id = ? AND json_extract(frontmatter, '$.linear') IS NOT NULL`,
    )
    .get(opts.vaultId) as { n: number; d: number } | undefined;

  const surfaces = edb
    .prepare(
      `SELECT COALESCE(surface_type, 'unknown') AS surface, COUNT(*) AS retrievals
       FROM chunk_retrievals WHERE 1=1${wWhere} GROUP BY surface_type ORDER BY retrievals DESC`,
    )
    .all(...wArgs) as Array<{ surface: string; retrievals: number }>;

  const topNotes = [...noteAgg.entries()]
    .map(([path, a]) => ({ path, access_count: a.access_count, citations: a.citations }))
    .sort((a, b) => b.access_count - a.access_count)
    .slice(0, opts.topN ?? 15);

  return {
    window: { since, until },
    totals: { chunks, notes, new_chunks: newChunks, retrievals, citations },
    access: {
      chunks_accessed: chunksAccessed,
      notes_accessed: noteAgg.size,
      stale_chunks: staleChunks,
      never_accessed_chunks: neverAccessed,
    },
    linked: {
      notes_with_linear: linkedRows?.n ?? 0,
      distinct_issues: linkedRows?.d ?? 0,
    },
    surfaces,
    top_notes: topNotes,
  };
}
