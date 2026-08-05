// THE-717 item 2 — the citation-pass run log: the writer half of migration 20260805_001.
//
// The whole point is that a NULL `citation_state` is THREE states wearing one face — never
// covered, covered-then-aborted, covered-then-crashed — and until now nothing recorded which.
// That is not a theoretical gap: `explain_answer` shipped on 2026-08-04 with a caveat asserting
// the first of the three, because the store offered no way to tell them apart.
//
// TWO CALLS, NOT ONE, and that is the design rather than an accident of shape:
//
//   openCitationRun()   at the START of a pass, before any work
//   closeCitationRun()  when the pass RETURNS, on every return path including the empty-scope one
//
// A pass that throws is deliberately NOT closed. There is no try/finally here on purpose: an
// unclosed row (`finished_at IS NULL`) is the durable evidence that a pass began and never came
// back, which is exactly state 3. Wrapping this in a finally would stamp a completion time on a
// pass that never completed and fold state 3 back into "ran, stamped nothing" — reintroducing the
// ambiguity the table exists to remove. `[[feedback-failure-encoded-as-a-valid-result]]`.
//
// The EMPTY-SCOPE return matters most of all. A pass over a scope with no unstamped rows does no
// work and writes no citation columns, so it is invisible in `chunk_retrievals` — and it is the
// single likeliest way for "the scheduler is running fine" to look identical to "the scheduler was
// never registered". It gets a row like any other pass.
import type { Database } from "../db/types";

/** Which axis a pass selected its rows on. Mirrors `inferCitations`'s only two scoping modes. */
export type CitationRunScope = "session" | "window";

export interface CitationRunOpen {
  scope: CitationRunScope;
  sessionId?: string | undefined;
  window?: [number, number] | undefined;
  /** False when no gateway judge was available — a stage-1-only pass. Not a failure, but a
   *  different claim: it stamps `candidate`, never `confirmed`. */
  judgePresent: boolean;
  startedAt: number;
}

export interface CitationRunClose {
  scoped: number;
  stage1Pass: number;
  judged: number;
  parseFailures: number;
  /** Rows actually written. THE number that matters — a pass can be healthy and stamp zero. */
  stamped: number;
  aborted: boolean;
  finishedAt: number;
}

/** One recorded pass, as a reader sees it. */
export interface CitationRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  scope_kind: string;
  session_id: string | null;
  window_from: number | null;
  window_until: number | null;
  scoped: number | null;
  stage1_pass: number | null;
  judged: number | null;
  parse_failures: number | null;
  stamped: number | null;
  aborted: number | null;
  judge_present: number;
}

/**
 * Record that a pass has BEGUN. Returns the row id to close it with.
 *
 * A `session`-scoped run with no session id is refused rather than written. Such a row is
 * incoherent — it claims an identity axis and supplies no identity — and it is specifically what
 * makes the reader's `session_id IS NOT NULL` guard load-bearing: without it, `session_id IS ?`
 * bound to NULL would match that row for EVERY caller who has no session, reporting "a pass
 * covered these rows" about a pass that covered nothing. Refusing at the write path keeps the
 * table free of the shape; the read guard still defends against rows written by anything else.
 */
export function openCitationRun(edb: Database, o: CitationRunOpen): number {
  if (o.scope === "session" && (o.sessionId === undefined || o.sessionId === "")) {
    throw new Error("openCitationRun: a session-scoped run requires a sessionId");
  }
  const res = edb
    .prepare(
      `INSERT INTO citation_runs
         (started_at, scope_kind, session_id, window_from, window_until, judge_present)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.startedAt,
      o.scope,
      o.sessionId ?? null,
      o.window?.[0] ?? null,
      o.window?.[1] ?? null,
      o.judgePresent ? 1 : 0,
    );
  return Number(res.lastInsertRowid);
}

/** Record that a pass RETURNED, with what it did. Never called on the throw path — see the header. */
export function closeCitationRun(edb: Database, id: number, c: CitationRunClose): void {
  edb
    .prepare(
      `UPDATE citation_runs
        SET finished_at = ?, scoped = ?, stage1_pass = ?, judged = ?,
            parse_failures = ?, stamped = ?, aborted = ?
      WHERE id = ?`,
    )
    .run(
      c.finishedAt,
      c.scoped,
      c.stage1Pass,
      c.judged,
      c.parseFailures,
      c.stamped,
      c.aborted ? 1 : 0,
      id,
    );
}

/**
 * Passes that covered a given retrieval window.
 *
 * A `session`-scoped pass is matched by session id; a `window`-scoped pass is matched by interval
 * OVERLAP rather than containment, because a pass covering 12:00-13:00 genuinely did cover a
 * retrieval at 12:30 even though it covers neither endpoint of a 12:20-12:40 query.
 *
 * Returns UNFINISHED passes too. A caller asking "has anything looked at these rows?" must be able
 * to see a pass that began and died, or it will conclude nothing ever ran.
 */
export function citationRunsCovering(
  edb: Database,
  window: [number, number],
  sessionId?: string | null,
): CitationRunRow[] {
  return edb
    .prepare(
      `SELECT * FROM citation_runs
        WHERE (scope_kind = 'window' AND window_from <= ? AND window_until >= ?)
           OR (scope_kind = 'session' AND session_id IS NOT NULL AND session_id = ?)
        ORDER BY started_at DESC
        LIMIT 50`,
    )
    .all(window[1], window[0], sessionId ?? null) as CitationRunRow[];
}
