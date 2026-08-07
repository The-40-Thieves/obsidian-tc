// Retrieval-event logging — THE-230, the capture half that makes the ACT-R activation
// recompute (./activation.ts) non-inert: serve-path search tools append one row per returned
// chunk to chunk_retrievals in the experiential store. TOOL-LAYER ONLY by design — the eval
// harness calls the search cores directly and must never pollute the log (THE-187 eval/serve
// hygiene). Best-effort: a logging failure goes to onError and never fails the search that
// triggered it. The judgement axes (cited_in_response / citation_score / feedback) ride these
// rows null, for TWO different reasons that are easy to conflate: the citation writer exists and
// is scheduled but is held by `experiential.citationInfer.enabled`, whereas `feedback` has no
// automatic producer at all and needs an agent to call record_retrieval_feedback. Neither is a
// missing dependency; one is config and one is adoption.
import { randomUUID } from "node:crypto";
import type { Database } from "../db/types";

export interface RetrievalLogHit {
  chunkId: string;
  /** 1-based rank in the result list as returned to the caller. */
  rank: number;
  /** Fused/rerank score passthrough (chunk_retrievals.rerank_score). */
  score?: number | null;
  /** THE-538: which fusion STREAM produced this hit (GraphSearchResult.source) — one of
   *  seed|expansion|lexical|sparse|temporal. Discarded at every call site before THE-538, which is
   *  why no logged outcome could be attributed to the stream that earned it. Absent on surfaces
   *  that have no streams (m2 semantic search). */
  streamSource?: string | null;
}

/**
 * THE-538: the ranking POLICY behind one search call — what configuration produced this ordering.
 * Written once per call to `retrieval_policy` and joined to that call's chunk_retrievals rows by
 * `event_group`.
 *
 * `arm` is always "control" and `propensity` always 1.0 today: this is instrumentation, it adds no
 * exploration arm and randomizes nothing. `propensity` is recorded anyway because it is the one
 * field that cannot be reconstructed later — the probability with which the serving policy chose
 * this configuration is knowable only at decision time.
 */
export interface RetrievalPolicyRecord {
  vaultId?: string | null;
  /** "static" | "idf" | "learned:v3" — which weighting policy produced the order. */
  policyId: string;
  arm?: string;
  denseW?: number | null;
  lexW?: number | null;
  sparseW?: number | null;
  fusionMode?: string | null;
  rrfK?: number | null;
  /** THE-258 class-router verdict for this query (standard|lexical|temporal). */
  routeClass?: string | null;
  propensity?: number;
}

export interface RetrievalLogEvent {
  queryText: string;
  /** Which serve surface retrieved it (tool name) — chunk_retrievals.surface_type. */
  surfaceType: string;
  sessionId?: string | null;
  /** THE-568: the calling principal — nullable, some paths (e.g. stdio/no-auth) lack one. */
  caller?: string | null;
  hits: RetrievalLogHit[];
  /** THE-538: absent -> no retrieval_policy row and a NULL event_group, i.e. byte-identical to
   *  the pre-THE-538 behaviour for any surface that has not been taught to describe its policy. */
  policy?: RetrievalPolicyRecord;
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
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, caller, surface_type, query_text, rank_in_results, rerank_score, event_group, stream_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertPolicy = edb.prepare(
    "INSERT INTO retrieval_policy (event_group, ts, vault_id, surface_type, policy_id, arm, dense_w, lex_w, sparse_w, fusion_mode, rrf_k, route_class, propensity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  return (event) => {
    if (event.hits.length === 0) return;
    const at = (opts.now ?? Date.now)();
    // THE-538: one id per SEARCH CALL. Minted only when the surface described its policy, so a
    // surface that has not been taught to do so still writes exactly the rows it wrote before,
    // with NULL in both new columns.
    const eventGroup = event.policy ? randomUUID() : null;
    try {
      edb.exec("BEGIN");
      try {
        // The policy row is written INSIDE the same transaction as its hits: a policy row with no
        // hits, or hits pointing at an event_group that does not exist, would be worse than no
        // provenance at all — a later join would silently drop or mis-attribute them.
        if (event.policy && eventGroup) {
          const p = event.policy;
          insertPolicy.run(
            eventGroup,
            at,
            p.vaultId ?? null,
            event.surfaceType,
            p.policyId,
            p.arm ?? "control",
            p.denseW ?? null,
            p.lexW ?? null,
            p.sparseW ?? null,
            p.fusionMode ?? null,
            p.rrfK ?? null,
            p.routeClass ?? null,
            p.propensity ?? 1.0,
          );
        }
        for (const h of event.hits) {
          insert.run(
            randomUUID(),
            h.chunkId,
            at,
            event.sessionId ?? null,
            event.caller ?? null,
            event.surfaceType,
            event.queryText,
            h.rank,
            h.score ?? null,
            eventGroup,
            h.streamSource ?? null,
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
