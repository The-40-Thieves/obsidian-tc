// Retrieval-event logging — THE-230, the capture half that makes the ACT-R activation
// recompute (./activation.ts) non-inert: serve-path search tools append one row per returned
// chunk to chunk_retrievals in the experiential store. TOOL-LAYER ONLY by design — the eval
// harness calls the search cores directly and must never pollute the log (THE-187 eval/serve
// hygiene). Best-effort: a logging failure goes to onError and never fails the search that
// triggered it. The outcome axis (cited_in_response / citation_score / feedback) rides these
// rows null until its writers land (THE-170 citation gate, feedback surface).
import { randomUUID } from "node:crypto";
import type { Database } from "../db/types";

export interface RetrievalLogHit {
  chunkId: string;
  /** 1-based rank in the result list as returned to the caller. */
  rank: number;
  /** Fused/rerank score passthrough (chunk_retrievals.rerank_score). */
  score?: number | null;
}

export interface RetrievalLogEvent {
  queryText: string;
  /** Which serve surface retrieved it (tool name) — chunk_retrievals.surface_type. */
  surfaceType: string;
  sessionId?: string | null;
  hits: RetrievalLogHit[];
}

export type RetrievalLogger = (event: RetrievalLogEvent) => void;

/**
 * Build the append-only logger over an open experiential.db handle. One transaction per
 * event (≤ top-K rows); never throws — errors are reported to onError and swallowed so
 * telemetry can never fail or slow a search result that is already computed.
 */
export function createRetrievalLogger(
  edb: Database,
  opts: { now?: () => number; onError?: (err: unknown) => void } = {},
): RetrievalLogger {
  const insert = edb.prepare(
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, query_text, rank_in_results, rerank_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  return (event) => {
    if (event.hits.length === 0) return;
    const at = (opts.now ?? Date.now)();
    try {
      edb.exec("BEGIN");
      try {
        for (const h of event.hits) {
          insert.run(
            randomUUID(),
            h.chunkId,
            at,
            event.sessionId ?? null,
            event.surfaceType,
            event.queryText,
            h.rank,
            h.score ?? null,
          );
        }
        edb.exec("COMMIT");
      } catch (err) {
        edb.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      opts.onError?.(err);
    }
  };
}
