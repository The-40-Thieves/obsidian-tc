// THE-249 — contribution-rate: score notes by how often they actually FED AN OUTPUT, not how
// often they were captured. The ticket's pre-citation design approximated "fed an output" via
// an event_log/args_hash/trace join; the THE-170 citation gate now measures it directly —
// cited_in_response on chunk_retrievals IS the output-contribution signal (with
// record_retrieval_feedback as the manual counterpart). Aggregation: per-chunk over the
// experiential store, mapped to note paths via the authored cache (two stores, membrane
// respected — no cross-file join), callers attributed via workspace_sessions.
import type { Database } from "../db/types";

export interface NoteContribution {
  path: string;
  retrievals: number;
  /** Retrieval events stamped cited_in_response = 1 (the output-contribution credits). */
  contributions: number;
  lastContributionTs: number | null;
  /** Distinct workspace-session callers whose sessions produced a contribution. */
  callers: string[];
}

export interface ContributionReport {
  window: { since: number | null; until: number | null };
  notes: NoteContribution[];
  totals: {
    retrievedPaths: number;
    contributingPaths: number;
    /** Retrieved in-window but never cited — the evidence-based review list. */
    deadRetrievedPaths: number;
  };
}

/**
 * Compute per-note contribution over a window. `edb` = experiential store
 * (chunk_retrievals), `cacheDb` = authored store (chunks for path mapping,
 * workspace_sessions for caller attribution).
 */
export function contributionReport(
  edb: Database,
  cacheDb: Database,
  opts: { since?: number; until?: number } = {},
): ContributionReport {
  const clauses = ["1=1"];
  const params: unknown[] = [];
  if (opts.since !== undefined) {
    clauses.push("retrieved_at >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    clauses.push("retrieved_at <= ?");
    params.push(opts.until);
  }
  const rows = edb
    .prepare(
      `SELECT chunk_id,
              COUNT(*) AS retrievals,
              SUM(CASE WHEN cited_in_response = 1 THEN 1 ELSE 0 END) AS contributions,
              MAX(CASE WHEN cited_in_response = 1 THEN retrieved_at END) AS last_contribution,
              GROUP_CONCAT(DISTINCT CASE WHEN cited_in_response = 1 THEN session_id END) AS sessions
       FROM chunk_retrievals WHERE ${clauses.join(" AND ")}
       GROUP BY chunk_id`,
    )
    .all(...params) as Array<{
    chunk_id: string;
    retrievals: number;
    contributions: number;
    last_contribution: number | null;
    sessions: string | null;
  }>;
  if (rows.length === 0) {
    return {
      window: { since: opts.since ?? null, until: opts.until ?? null },
      notes: [],
      totals: { retrievedPaths: 0, contributingPaths: 0, deadRetrievedPaths: 0 },
    };
  }

  // chunk -> path via the authored store (batched IN; membrane means no cross-db join).
  const pathByChunk = new Map<string, string>();
  const ids = rows.map((r) => r.chunk_id);
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    const placeholders = batch.map(() => "?").join(",");
    const mapped = cacheDb
      .prepare(`SELECT id, path FROM chunks WHERE id IN (${placeholders})`)
      .all(...batch) as Array<{ id: string; path: string }>;
    for (const m of mapped) pathByChunk.set(m.id, m.path);
  }

  // session -> caller via workspace_sessions (best-effort; table may be empty).
  const sessionIds = new Set<string>();
  for (const r of rows) {
    for (const s of (r.sessions ?? "").split(",")) if (s) sessionIds.add(s);
  }
  const callerBySession = new Map<string, string>();
  const sids = [...sessionIds];
  for (let i = 0; i < sids.length; i += 400) {
    const batch = sids.slice(i, i + 400);
    const placeholders = batch.map(() => "?").join(",");
    try {
      const mapped = cacheDb
        .prepare(`SELECT id, caller FROM workspace_sessions WHERE id IN (${placeholders})`)
        .all(...batch) as Array<{ id: string; caller: string | null }>;
      for (const m of mapped) if (m.caller) callerBySession.set(m.id, m.caller);
    } catch {
      // workspace_sessions absent (minimal harness) — callers stay empty.
    }
  }

  const byPath = new Map<string, NoteContribution>();
  for (const r of rows) {
    const path = pathByChunk.get(r.chunk_id);
    if (!path) continue; // chunk deleted since retrieval
    const entry = byPath.get(path) ?? {
      path,
      retrievals: 0,
      contributions: 0,
      lastContributionTs: null,
      callers: [],
    };
    entry.retrievals += r.retrievals;
    entry.contributions += r.contributions;
    if (
      r.last_contribution !== null &&
      (entry.lastContributionTs === null || r.last_contribution > entry.lastContributionTs)
    ) {
      entry.lastContributionTs = r.last_contribution;
    }
    for (const s of (r.sessions ?? "").split(",")) {
      const caller = s ? callerBySession.get(s) : undefined;
      if (caller && !entry.callers.includes(caller)) entry.callers.push(caller);
    }
    byPath.set(path, entry);
  }

  const notes = [...byPath.values()].sort(
    (a, b) => b.contributions - a.contributions || b.retrievals - a.retrievals,
  );
  const contributingPaths = notes.filter((n) => n.contributions > 0).length;
  return {
    window: { since: opts.since ?? null, until: opts.until ?? null },
    notes,
    totals: {
      retrievedPaths: notes.length,
      contributingPaths,
      deadRetrievedPaths: notes.length - contributingPaths,
    },
  };
}
