// THE-537 — the note_quality rollup: an OFFLINE pass over data that already exists, modelled on
// recomputeActivation. No inference, no gateway, no ranking change, no ship gate.
//
// Two definitional conflicts are resolved here EXPLICITLY rather than at the call site:
//
// 1. "STALE" MEANS TWO DIFFERENT THINGS in this codebase — 365 days since EDIT (search/freshness.ts)
//    and 30 days since RETRIEVAL (experiential/metrics.ts). They are kept as SEPARATE columns and
//    SEPARATE flags (`stale_edit` / `stale_access`). Blending them would produce a number that
//    answers neither question: a reference note edited once and read weekly is not stale, and a
//    draft edited yesterday and never read is not fresh in the sense a reader cares about.
//
// 2. "ORPHAN" HAS NO PERSISTED FORM. `find_orphans` (tools/m1/links-tools.ts) walks the filesystem;
//    it is accurate but slow and needs vault FS access. This pass uses vault_edges DEGREE instead:
//    DB-only, cheap, and available offline. The difference matters and is not hidden — a note whose
//    only inbound links are UNRESOLVED (pointing at a path that does not exist, so no edge row was
//    ever written) counts as an orphan here and does not under the walk. Degree-orphan is the
//    weaker, cheaper claim; the flag name says `orphan` and this comment says what it means.
//
// NOT THE RANKER. Nothing in the retrieval path may import this module — feeding quality_score into
// fusion is a ranking change requiring its own eval gate. `note-quality.test.ts` greps for that.

import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";

/** Days since last EDIT beyond which a note is `stale_edit`. Mirrors search/freshness.ts. */
export const STALE_EDIT_DAYS = 365;
/** Days since last RETRIEVAL beyond which a note is `stale_access`. Mirrors metrics.ts's 30d cut. */
export const STALE_ACCESS_DAYS = 30;
/** Bump when the scoring formula changes. Old rows keep their own version and stay honest. */
export const SCORE_VERSION = 1;
const MS_PER_DAY = 86_400_000;
/** Cross-store id batching, matching experiential/metrics.ts — chunk_retrievals has no vault_id. */
const BATCH = 200;

export interface NoteQualityRow {
  vault_id: string;
  path: string;
  computed_at: number;
  chunk_count: number;
  dup_chunk_count: number;
  dup_ratio: number | null;
  mtime: number | null;
  age_days: number | null;
  last_retrieved_at: number | null;
  retrievals: number;
  citations: number;
  outcome_balance: number;
  in_degree: number;
  out_degree: number;
  orphan: number;
  contradictions_open: number;
  tombstoned: number;
  quality_score: number | null;
  score_version: number;
  flags: string;
}

export interface NoteQualityStats {
  notes: number;
  scored: number;
  /** Rows whose evidence was insufficient to score — quality_score IS NULL. */
  unscored: number;
  flagged: number;
}

export function hasNoteQuality(edb: Database): boolean {
  return tableExists(edb, "note_quality");
}

// THE-620: columnExists re-introspects sqlite_master on every recomputeNoteQuality run, but the
// schema cannot change between scheduler runs without a migration and a restart — the answer is
// invariant for the lifetime of a connection. Memoized per Database instance via a WeakMap, NOT a
// module-level boolean: the suite opens many databases in one process (node:sqlite in-memory), and
// a bare global would leak one database's schema answer into every other database's runs.
const bodyShaColumnCache = new WeakMap<Database, boolean>();

function hasBodyShaColumn(cacheDb: Database): boolean {
  const cached = bodyShaColumnCache.get(cacheDb);
  if (cached !== undefined) return cached;
  const result = columnExists(cacheDb, "chunks", "body_sha");
  bodyShaColumnCache.set(cacheDb, result);
  return result;
}

/**
 * The score. Deliberately simple, deliberately explicit about not knowing.
 *
 * Returns NULL when there is no usage evidence at all: citations are near-zero in practice today,
 * so a naive formula would rank the entire vault as low-quality and be worse than nothing.
 * "Unmeasured" and "bad" must stay distinguishable — a report that calls every unread note bad is
 * one a user stops reading, and then the flags that ARE trustworthy go unread with it.
 *
 * Structural problems (duplicate bodies, orphaning, open contradictions) are reported as FLAGS
 * regardless, because those are knowable without any usage evidence.
 */
export function scoreNote(row: Omit<NoteQualityRow, "quality_score" | "flags">): number | null {
  if (row.retrievals === 0) return null;
  // Usefulness: citations-per-retrieval, nudged by the outcome balance, penalised for duplication.
  const citationRate = row.citations / row.retrievals;
  const outcome = Math.max(-1, Math.min(1, row.outcome_balance / row.retrievals));
  const dupPenalty = row.dup_ratio ?? 0;
  const raw = 0.6 * citationRate + 0.2 * ((outcome + 1) / 2) + 0.2 * (1 - dupPenalty);
  return Math.max(0, Math.min(1, raw));
}

/** The flags a human actually reads. Order is stable so two runs produce identical JSON. */
export function flagsFor(
  row: Omit<NoteQualityRow, "quality_score" | "flags">,
  nowMs: number,
): string[] {
  const flags: string[] = [];
  if (row.dup_chunk_count > 0) flags.push("duplicate");
  if (row.orphan === 1) flags.push("orphan");
  if (row.age_days !== null && row.age_days > STALE_EDIT_DAYS) flags.push("stale_edit");
  if (
    row.last_retrieved_at !== null &&
    (nowMs - row.last_retrieved_at) / MS_PER_DAY > STALE_ACCESS_DAYS
  ) {
    flags.push("stale_access");
  }
  if (row.contradictions_open > 0) flags.push("contradicted");
  if (row.tombstoned === 1) flags.push("tombstoned");
  return flags;
}

/**
 * Recompute the rollup for one vault. Idempotent: running twice produces identical rows except
 * `computed_at` (upsert on the (vault_id, path) primary key, never an append).
 */
export function recomputeNoteQuality(
  cacheDb: Database,
  edb: Database,
  opts: { vaultId: string; nowMs: number },
): NoteQualityStats {
  const { vaultId, nowMs } = opts;
  if (!hasNoteQuality(edb)) return { notes: 0, scored: 0, unscored: 0, flagged: 0 };

  // --- authored side (cache.db) -------------------------------------------------------------
  const notes = cacheDb
    .prepare("SELECT path, mtime FROM notes WHERE vault_id = ?")
    .all(vaultId) as Array<{ path: string; mtime: number }>;

  const chunkCounts = new Map<string, number>();
  const dupCounts = new Map<string, number>();
  const hasBodySha = hasBodyShaColumn(cacheDb);
  const chunkRows = cacheDb
    .prepare(
      hasBodySha
        ? "SELECT id, path, body_sha FROM chunks WHERE vault_id = ?"
        : "SELECT id, path, NULL AS body_sha FROM chunks WHERE vault_id = ?",
    )
    .all(vaultId) as Array<{ id: string; path: string; body_sha: string | null }>;

  // A body is "duplicated" when the same body_sha appears under MORE THAN ONE path. Repetition
  // within a single note is structure, not duplication, so paths are collected per sha as a set.
  const pathsBySha = new Map<string, Set<string>>();
  for (const c of chunkRows) {
    chunkCounts.set(c.path, (chunkCounts.get(c.path) ?? 0) + 1);
    if (c.body_sha) {
      let set = pathsBySha.get(c.body_sha);
      if (!set) {
        set = new Set();
        pathsBySha.set(c.body_sha, set);
      }
      set.add(c.path);
    }
  }
  for (const c of chunkRows) {
    if (c.body_sha && (pathsBySha.get(c.body_sha)?.size ?? 0) > 1) {
      dupCounts.set(c.path, (dupCounts.get(c.path) ?? 0) + 1);
    }
  }

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  if (tableExists(cacheDb, "vault_edges")) {
    for (const e of cacheDb
      .prepare("SELECT source_path, target_path FROM vault_edges WHERE vault_id = ?")
      .all(vaultId) as Array<{ source_path: string; target_path: string }>) {
      outDeg.set(e.source_path, (outDeg.get(e.source_path) ?? 0) + 1);
      inDeg.set(e.target_path, (inDeg.get(e.target_path) ?? 0) + 1);
    }
  }

  const openContradictions = new Map<string, number>();
  if (tableExists(cacheDb, "contradictions")) {
    for (const r of cacheDb
      .prepare(
        "SELECT source_path, conflict_path FROM contradictions WHERE vault_id = ? AND status = 'open'",
      )
      .all(vaultId) as Array<{ source_path: string; conflict_path: string }>) {
      // A contradiction implicates BOTH notes; a report listing only one side sends the reader to
      // a note whose problem is invisible from there.
      for (const p of [r.source_path, r.conflict_path]) {
        openContradictions.set(p, (openContradictions.get(p) ?? 0) + 1);
      }
    }
  }

  // --- usage side (experiential.db) ----------------------------------------------------------
  // chunk_access_stats is keyed by chunk_id and the two stores are separate files, so the chunk ->
  // path mapping is joined in JS over batched id slices, exactly as metrics.ts does.
  const stats = new Map<
    string,
    { access_count: number; last_accessed_at: number; citations: number; outcome_balance: number }
  >();
  // THE-620: this queries the chunk_access_stats VIEW, not the chunk_retrievals table it wraps —
  // guard on the view's own existence, since it is a LATER migration (20260712_002) than the table
  // (20260626_001). A connection migrated only as far as chunk_retrievals (a "minimal harness",
  // same shape contribution.test.ts builds for workspace_sessions) has the table without the view,
  // and the old `tableExists(edb, "chunk_retrievals")` guard let that case reach the query below and
  // throw "no such table: chunk_access_stats".
  if (tableExists(edb, "chunk_access_stats", { includeViews: true })) {
    for (const s of edb
      .prepare(
        "SELECT chunk_id, access_count, last_accessed_at, citations, outcome_balance FROM chunk_access_stats",
      )
      .all() as Array<{
      chunk_id: string;
      access_count: number;
      last_accessed_at: number;
      citations: number;
      outcome_balance: number;
    }>) {
      stats.set(s.chunk_id, s);
    }
  }
  const pathByChunk = new Map<string, string>();
  const ids = [...stats.keys()];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    for (const r of cacheDb
      .prepare(
        `SELECT id, path FROM chunks WHERE vault_id = ? AND id IN (${batch.map(() => "?").join(",")})`,
      )
      .all(vaultId, ...batch) as Array<{ id: string; path: string }>) {
      pathByChunk.set(r.id, r.path);
    }
  }
  const usage = new Map<
    string,
    { retrievals: number; citations: number; outcome: number; last: number | null }
  >();
  for (const [chunkId, s] of stats) {
    const path = pathByChunk.get(chunkId);
    if (path === undefined) continue; // deleted or foreign-vault chunk
    const u = usage.get(path) ?? { retrievals: 0, citations: 0, outcome: 0, last: null };
    u.retrievals += s.access_count;
    u.citations += s.citations;
    u.outcome += s.outcome_balance;
    u.last = u.last === null ? s.last_accessed_at : Math.max(u.last, s.last_accessed_at);
    usage.set(path, u);
  }

  const tombstoned = new Set<string>();
  if (tableExists(edb, "forget_log")) {
    for (const r of edb
      .prepare("SELECT target FROM forget_log WHERE kind = 'note' AND mode = 'tombstone'")
      .all() as Array<{ target: string }>) {
      tombstoned.add(r.target);
    }
  }

  // --- assemble + upsert ---------------------------------------------------------------------
  const upsert = edb.prepare(
    `INSERT INTO note_quality (
       vault_id, path, computed_at, chunk_count, dup_chunk_count, dup_ratio, mtime, age_days,
       last_retrieved_at, retrievals, citations, outcome_balance, in_degree, out_degree, orphan,
       contradictions_open, tombstoned, quality_score, score_version, flags
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, path) DO UPDATE SET
       computed_at = excluded.computed_at, chunk_count = excluded.chunk_count,
       dup_chunk_count = excluded.dup_chunk_count, dup_ratio = excluded.dup_ratio,
       mtime = excluded.mtime, age_days = excluded.age_days,
       last_retrieved_at = excluded.last_retrieved_at, retrievals = excluded.retrievals,
       citations = excluded.citations, outcome_balance = excluded.outcome_balance,
       in_degree = excluded.in_degree, out_degree = excluded.out_degree, orphan = excluded.orphan,
       contradictions_open = excluded.contradictions_open, tombstoned = excluded.tombstoned,
       quality_score = excluded.quality_score, score_version = excluded.score_version,
       flags = excluded.flags`,
  );

  const out: NoteQualityStats = { notes: 0, scored: 0, unscored: 0, flagged: 0 };
  edb.exec("BEGIN");
  try {
    for (const n of notes) {
      const chunk_count = chunkCounts.get(n.path) ?? 0;
      const dup_chunk_count = dupCounts.get(n.path) ?? 0;
      // NULL, not 0, when body_sha is unavailable: "no duplicate bodies" and "we cannot tell"
      // are different claims and a 0 would assert the first.
      const dup_ratio = !hasBodySha || chunk_count === 0 ? null : dup_chunk_count / chunk_count;
      const u = usage.get(n.path);
      const in_degree = inDeg.get(n.path) ?? 0;
      const out_degree = outDeg.get(n.path) ?? 0;
      const base = {
        vault_id: vaultId,
        path: n.path,
        computed_at: nowMs,
        chunk_count,
        dup_chunk_count,
        dup_ratio,
        mtime: n.mtime ?? null,
        age_days: n.mtime ? (nowMs - n.mtime) / MS_PER_DAY : null,
        last_retrieved_at: u?.last ?? null,
        retrievals: u?.retrievals ?? 0,
        citations: u?.citations ?? 0,
        outcome_balance: u?.outcome ?? 0,
        in_degree,
        out_degree,
        orphan: in_degree === 0 && out_degree === 0 ? 1 : 0,
        contradictions_open: openContradictions.get(n.path) ?? 0,
        tombstoned: tombstoned.has(n.path) ? 1 : 0,
        score_version: SCORE_VERSION,
      };
      const quality_score = scoreNote(base);
      const flags = flagsFor(base, nowMs);
      upsert.run(
        base.vault_id,
        base.path,
        base.computed_at,
        base.chunk_count,
        base.dup_chunk_count,
        base.dup_ratio,
        base.mtime,
        base.age_days,
        base.last_retrieved_at,
        base.retrievals,
        base.citations,
        base.outcome_balance,
        base.in_degree,
        base.out_degree,
        base.orphan,
        base.contradictions_open,
        base.tombstoned,
        quality_score,
        base.score_version,
        JSON.stringify(flags),
      );
      out.notes++;
      if (quality_score === null) out.unscored++;
      else out.scored++;
      if (flags.length > 0) out.flagged++;
    }
    edb.exec("COMMIT");
  } catch (err) {
    edb.exec("ROLLBACK");
    throw err;
  }
  return out;
}

/** Read side for the CLI and the MCP report tool. `flags` filters to rows carrying ALL of them. */
export function readNoteQuality(
  edb: Database,
  opts: { vaultId: string; flags?: string[]; limit?: number },
): NoteQualityRow[] {
  if (!hasNoteQuality(edb)) return [];
  const rows = edb
    .prepare(
      // NULL scores last: an unmeasured note is not a good note, and it is not a bad one either —
      // it must not head a list the reader will interpret as "worst first".
      "SELECT * FROM note_quality WHERE vault_id = ? ORDER BY quality_score IS NULL, quality_score ASC, path ASC",
    )
    .all(opts.vaultId) as NoteQualityRow[];
  const wanted = opts.flags ?? [];
  const filtered =
    wanted.length === 0
      ? rows
      : rows.filter((r) => {
          const have = new Set(JSON.parse(r.flags) as string[]);
          return wanted.every((f) => have.has(f));
        });
  return opts.limit === undefined ? filtered : filtered.slice(0, opts.limit);
}

function columnExists(db: Database, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}
