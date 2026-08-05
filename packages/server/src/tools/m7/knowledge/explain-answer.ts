// THE-646 item 2 — `explain_answer`: what did this answer actually use?
//
// Deliberately the SIBLING of diagnose_retrieval (THE-632), not a parallel surface. Two comments on
// THE-646 recommended exactly this and gave the reason: the two tools are the same traversal in
// opposite directions — `diagnose_retrieval` asks *why was this note NOT returned*, this asks *what
// did this answer use* — and building them apart designs the ACL story twice. THE-632 shipped
// first, so this reuses its shape: same `defineTool` envelope, same `readableRel(ctx.acl, …)`
// read-filter, same `read:notes` scope, schema in the same file.
//
// The chain itself lives in `experiential/lineage.ts` as a PURE function, so the honest-absence
// logic is testable against fixtures without a live store. This file is the DB and authorization
// half only.
//
// AUTHORIZATION IS TWO LAYERS, and the first is the partition:
//
//   1. OWNERSHIP — `caller`. THE-568 made per-caller ownership the primary boundary on
//      chunk_retrievals. The identity test is `typeof caller === "string" && length > 0`, NOT a
//      null check: `auth/jwt.ts` never requires `sub`, so a valid token can yield `caller: null`,
//      and `AND caller IS ?` would then bind NULL — which SQLite's `IS` treats as a value, matching
//      every row predating the caller column (81 of 97 on the live store when feedback-scope.ts
//      measured it). An unidentifiable principal must not inherit unowned retrievals.
//   2. READABILITY — `readableRel(ctx.acl, path)`. A lineage that names a path the caller cannot
//      read leaks its existence and its relevance to a query; the THE-563/564 class.
//
// Unreadable rows are DROPPED, not relabelled. Reporting them as `deleted` would be a lie about the
// vault, and reporting a suppressed COUNT would leak how much is hidden. Dropping is the only
// option that says nothing.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../../db/types";
import {
  buildAnswerLineage,
  CORRELATION_WINDOW_MS,
  type LineageEpisodeRow,
  type LineageRetrievalRow,
} from "../../../experiential/lineage";
import type { ToolDefinition } from "../../../mcp/registry";
import { readableRel } from "../../../vault/acl-read-filter";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import { ExplainAnswerOutput } from "./schemas";

/** Widest window the caller may ask to explain, so one call cannot walk the whole retrieval log. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

interface RetrievalRow {
  chunk_id: string;
  retrieved_at: number;
  surface_type: string;
  query_text: string | null;
  rank_in_results: number | null;
  session_id: string | null;
  cited_in_response: number | null;
  citation_score: number | null;
  citation_state: string | null;
}

export function createExplainAnswerTool(deps: M7Deps): ToolDefinition {
  return defineTool({
    name: "explain_answer",
    domain: "knowledge",
    description:
      "Explain what an answer actually used: walks retrieval -> chunk -> citation -> episode for one session or time window and reports each link with how well it is known. Distinguishes a retrieval the citation pass never judged from one it judged and rejected, and a chunk whose note no longer exists from one that was never used. Read-only; reports nothing about paths the caller cannot read.",
    inputSchema: z
      .object({
        vault: VaultId,
        /** Explain one session. Exact — prefer it over a window whenever a session id is known. */
        session_id: z.string().min(1).optional(),
        /** Or a retrieved_at window, in ms epoch. Used only when session_id is absent. */
        since: z.number().int().nonnegative().optional(),
        until: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200).default(50),
      })
      .strict(),
    outputSchema: ExplainAnswerOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "provenance", "diagnostics"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const edb = deps.edb;
      if (!edb) {
        // Not an error: the store being closed is a configuration state, not a failed call. Same
        // shape m8 returns for the same condition.
        return {
          available: false as const,
          message:
            "experiential store is not open (enable experiential.logRetrievals or captureEpisodes)",
        };
      }
      // Layer 1: ownership. Identity, not a null check — see the header.
      const identified = typeof ctx.caller === "string" && ctx.caller.length > 0;
      if (!identified) {
        throw err.forbidden("explain_answer requires an identified caller");
      }
      if (input.session_id === undefined && input.since === undefined) {
        throw err.invalidInput("explain_answer requires either session_id or since");
      }
      const until = input.until ?? Date.now();
      if (input.since !== undefined && until - input.since > MAX_WINDOW_MS) {
        throw err.invalidInput(
          `explain_answer window exceeds the ${MAX_WINDOW_MS}ms maximum; narrow it or pass a session_id`,
        );
      }

      const scope =
        input.session_id !== undefined
          ? { clause: "session_id = ?", params: [input.session_id] as unknown[] }
          : { clause: "retrieved_at BETWEEN ? AND ?", params: [input.since, until] as unknown[] };

      const rows = edb
        .prepare(
          `SELECT chunk_id, retrieved_at, surface_type, query_text, rank_in_results, session_id,
                  cited_in_response, citation_score, citation_state
             FROM chunk_retrievals
            WHERE ${scope.clause} AND caller IS ?
            ORDER BY retrieved_at DESC, rank_in_results ASC
            LIMIT ?`,
        )
        .all(...scope.params, ctx.caller, input.limit) as RetrievalRow[];

      // Resolve paths from the AUTHORED store. A chunk_id with no row here is genuinely gone
      // (the note was edited or deleted and re-chunked), which the lineage reports rather than
      // drops — 7 of 81 distinct retrieved chunk_ids on the live store.
      const pathOf = pathResolver(ctx.db, v.id);
      const retrievals: LineageRetrievalRow[] = [];
      for (const r of rows) {
        const path = pathOf(r.chunk_id);
        // Layer 2: readability. An unreadable path is dropped entirely — never relabelled, never
        // counted. `null` here means "no longer exists", which is a different claim.
        if (path !== null && !readableRel(ctx.acl, path)) continue;
        retrievals.push({ ...r, path });
      }

      const episodes = edb
        .prepare(
          `SELECT id, ts, session_id FROM agent_episodes
            WHERE blocked = 0 AND caller IS ? AND ts BETWEEN ? AND ?
            ORDER BY ts DESC LIMIT 500`,
        )
        .all(
          ctx.caller,
          (retrievals.at(-1)?.retrieved_at ?? until) - CORRELATION_WINDOW_MS,
          (retrievals[0]?.retrieved_at ?? until) + CORRELATION_WINDOW_MS,
        ) as LineageEpisodeRow[];

      const lineage = buildAnswerLineage(retrievals, episodes);
      return {
        available: true as const,
        vault: v.id,
        scope: (input.session_id !== undefined ? "session" : "time_window") as
          | "session"
          | "time_window",
        ...lineage,
      };
    },
  });
}

/** Memoised chunk_id -> path lookup over the authored store. Returns null when the chunk is gone. */
function pathResolver(db: Database, vaultId: string): (chunkId: string) => string | null {
  const stmt = db.prepare("SELECT path FROM chunks WHERE id = ? AND vault_id = ?");
  const cache = new Map<string, string | null>();
  return (chunkId) => {
    const hit = cache.get(chunkId);
    if (hit !== undefined) return hit;
    const row = stmt.get(chunkId, vaultId) as { path: string } | undefined;
    const path = row?.path ?? null;
    cache.set(chunkId, path);
    return path;
  };
}
