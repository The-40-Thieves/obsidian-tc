// THE-718 — the scoping and no-op-reason logic behind `record_retrieval_feedback`.
//
// Lifted out of experiential-tools.ts for the same reason goal-tools.ts and shared.ts were: the
// parent sits against biome's 700-line ceiling, and the scoping rules here stopped being a clause
// you read inline the moment a no-op had to explain itself. This module imports from ./shared only
// — never back from experiential-tools.ts — so the boundary gate's zero-cycle baseline holds.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../../db/types";
import type { CallerContext } from "../../mcp/registry";
import { CROSS_PRINCIPAL_SCOPE, canCrossPrincipal } from "./shared";

export interface FeedbackStampInput {
  chunk_id: string;
  feedback?: number;
  outcome?: number;
  session_id?: string;
  last_n: number;
}

/** Why nothing was stamped. Absent on a successful write — a caller branches on its presence. */
export type FeedbackNoopReason = "session_scope" | "no_owned_retrievals";

export interface FeedbackStampResult {
  available: true;
  chunk_id: string;
  updated: number;
  reason?: FeedbackNoopReason;
}

/**
 * Stamp feedback/outcome onto the most recent retrieval event(s) for a chunk.
 *
 * Authorization is two layers, and only the first is a partition. THE-568 made per-caller ownership
 * the primary boundary (`AND caller IS ?`), mirroring the agent_episodes partition; P1.7's session
 * scoping is a narrowing on top of it, and `admin:workspace` crosses both.
 *
 * THE-718: `session_id IS NULL` is deliberately in scope for the session narrowing. A retrieval
 * logged outside any session belongs to no session, so there is no second session to confuse it
 * with and ownership is carried entirely by `caller`. Without that, the narrowing was a deny-all in
 * practice — measured against the live store 2026-08-03, `session_id` was NULL on 97/97 rows
 * because nothing calls `start_session` (THE-714), so `admin:workspace` was the only principal that
 * could stamp anything. Rows that DO carry a session stay reachable only from that session.
 */
export function stampRetrievalFeedback(
  edb: Database,
  input: FeedbackStampInput,
  ctx: CallerContext,
): FeedbackStampResult {
  const session = input.session_id ?? ctx.sessionId;
  const crossPrincipal = canCrossPrincipal(ctx);
  if (session === undefined && !crossPrincipal)
    throw err.forbidden(
      `stamping feedback across sessions requires a session_id or the ${CROSS_PRINCIPAL_SCOPE} scope`,
    );
  const sessionClause = session !== undefined ? "AND (session_id = ? OR session_id IS NULL)" : "";
  const callerClause = crossPrincipal ? "" : "AND caller IS ?";
  const ownerParams = crossPrincipal ? [] : [ctx.caller ?? null];
  const selectParams: unknown[] = [input.chunk_id];
  if (session !== undefined) selectParams.push(session);
  selectParams.push(...ownerParams);

  const res = edb
    .prepare(
      `UPDATE chunk_retrievals
         SET feedback = COALESCE(?, feedback), outcome = COALESCE(?, outcome)
       WHERE id IN (
         SELECT id FROM chunk_retrievals WHERE chunk_id = ? ${sessionClause} ${callerClause}
         ORDER BY retrieved_at DESC LIMIT ?
       )`,
    )
    .run(input.feedback ?? null, input.outcome ?? null, ...selectParams, input.last_n);
  if (res.changes > 0) return { available: true, chunk_id: input.chunk_id, updated: res.changes };

  // `updated: 0` is otherwise the same response shape as a successful stamp, and in production it
  // was 100% of calls. The probe drops the session narrowing but KEEPS the caller clause, so it
  // only ever sees rows this caller already owns: a foreign caller's chunk and a chunk that does
  // not exist are indistinguishable, the same no-existence-oracle rule work_forget follows for a
  // foreign episode id.
  const owned = edb
    .prepare(`SELECT 1 FROM chunk_retrievals WHERE chunk_id = ? ${callerClause} LIMIT 1`)
    .get(input.chunk_id, ...ownerParams);
  return {
    available: true,
    chunk_id: input.chunk_id,
    updated: 0,
    reason: owned ? "session_scope" : "no_owned_retrievals",
  };
}
