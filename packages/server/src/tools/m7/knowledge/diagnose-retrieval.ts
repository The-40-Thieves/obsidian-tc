// THE-632: `diagnose_retrieval` — why was this note NOT returned?
//
// Before this, the only way to answer that was to re-run variations of the query and guess. The
// interesting cases are all indistinguishable from the outside: below the dense threshold, never a
// candidate, reached but demoted by the reranker, or cut by the diversity top-K all look identical
// to "it didn't come back".
//
// SEPARATE TOOL, not a `debug: true` flag on search. A debug flag on the hot path is a permanent
// branch in production code and an invitation to leave it on.
//
// It RE-RUNS the real pipeline with tracing enabled rather than reading retained per-stage state.
// That is not a shortcut, it is the only correct shape: StageMetric is aggregate-only and carries
// no chunk identity, so there is nothing retained to read (see instrumentation.ts). Retaining it
// would tax every normal search to serve a diagnostic nobody is running, and a debug path that
// diverges from production answers a question about itself.
//
// ACL (THE-563/564): this is a disclosure surface. Reporting "note X scored 0.41" for a path the
// caller cannot read leaks both the path's existence and its similarity to the query. Two things
// make that safe here:
//   1. `isReadable` already filters at seedGeneration, graphExpansion and candidateAssembly — every
//      array the trace inspects is ACL-filtered before it exists. The guarantee is structural.
//   2. The handler ALSO checks the target up front, rather than relying on that emergent property.
//      An unreadable path returns the SAME shape as a path that simply never matched — no branch,
//      no distinct error, no timing tell. A refusal that says "you may not read that" is an
//      existence oracle; this deliberately is not one.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { graphSearch } from "../../../search/graph_search";
import type { RetrievalTraceRecord } from "../../../search/graph_search_stages/instrumentation";
import { readableRel } from "../../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import { buildGraphSearchOptions, type RetrievalRuntime } from "./retrieval-runtime";
import { DiagnoseRetrievalOutput } from "./schemas";

/**
 * Turn the raw stage records into the one sentence a human actually wants.
 *
 * `dropped_at` is the FIRST stage where the note stopped being present — everything after it is
 * downstream of the real cause, so naming the last stage (or every stage) would bury the finding.
 */
export function summarize(
  path: string,
  records: RetrievalTraceRecord[],
): { returned: boolean; droppedAt: string | null; summary: string } {
  const last = records.at(-1);
  const returned = last?.present === true;
  if (records.length === 0) {
    return {
      returned: false,
      droppedAt: null,
      summary: `The pipeline terminated before any traced stage ran, so ${path} was never evaluated. This usually means the query produced no seeds at all.`,
    };
  }
  if (returned) {
    return {
      returned: true,
      droppedAt: null,
      summary: `${path} WAS returned (${last?.chunksPresent} chunk(s) survived to projection). If it is not where you expected in the ranking, compare its rank across the stages below.`,
    };
  }
  const first = records[0];
  // Never a candidate: the most common real answer, and the one that has no score anywhere to
  // explain it. Distinguished from "was a candidate and got cut" because the fixes differ —
  // indexing/embedding vs ranking.
  if (first && !first.present) {
    return {
      returned: false,
      droppedAt: first.stage,
      summary: `${path} never entered the candidate pool at ${first.stage}, so no later stage ever scored it. It was not retrieved by any arm (dense seeds, lexical, sparse, or graph expansion) — check that the note is indexed and that the query shares vocabulary or a link path with it.`,
    };
  }
  const dropIdx = records.findIndex((r) => !r.present);
  const drop = dropIdx >= 0 ? records[dropIdx] : undefined;
  const prev = dropIdx > 0 ? records[dropIdx - 1] : undefined;
  if (!drop) {
    return {
      returned: false,
      droppedAt: null,
      summary: `${path} was present at every traced stage but is not in the final results — this is unexpected; report it.`,
    };
  }
  const at = prev
    ? ` It was still present at ${prev.stage}${prev.rank !== undefined ? ` (rank ${prev.rank}${prev.score !== undefined ? `, score ${prev.score.toFixed(4)}` : ""})` : ""}, out of ${prev.candidatesOut} candidate(s).`
    : "";
  return {
    returned: false,
    droppedAt: drop.stage,
    summary: `${path} was dropped at ${drop.stage}, which took ${drop.candidatesIn} candidate(s) in and passed ${drop.candidatesOut} out.${at}${drop.note ? ` ${drop.note}` : ""}`,
  };
}

export function createDiagnoseRetrievalTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
): ToolDefinition {
  return defineTool({
    name: "diagnose_retrieval",
    domain: "knowledge",
    description:
      "Explain why a specific note was or was not returned for a query. Re-runs the retrieval pipeline with per-stage tracing and reports, for that one note, where it was present, its score and rank where a stage produces them, and the first stage that dropped it. Read-only and non-mutating; reports nothing about paths the caller cannot read.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(1),
        /** The note you expected to see. Vault-relative, same shape as every other path arg. */
        path: VaultPath,
        final_top_k: z.number().int().positive().max(100).default(30),
      })
      .strict(),
    outputSchema: DiagnoseRetrievalOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search", "diagnostics"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const rel = normalizeVaultPath(input.path);
      const records: RetrievalTraceRecord[] = [];

      // ACL, stated up front rather than left to the pipeline's own filtering. An unreadable path
      // takes the SAME branch as one that never matched, so the response cannot be used to probe
      // for a note's existence — see this file's header.
      if (!readableRel(ctx.acl, rel)) {
        return {
          vault: v.id,
          query: input.query,
          path: rel,
          returned: false,
          dropped_at: null,
          summary: `${rel} never entered the candidate pool, so no later stage ever scored it. It was not retrieved by any arm — check that the note is indexed and that the query shares vocabulary or a link path with it.`,
          stages: [],
        };
      }

      const vectors = await retrieval.embedAll(input.query, input.query);
      const options = buildGraphSearchOptions(deps, {
        route: { class: "standard" },
        query: input.query,
        vaultId: v.id,
        finalTopK: input.final_top_k,
        reranker: deps.reranker,
        isReadable: (p) => readableRel(ctx.acl, p),
        traceNotePath: rel,
        onRetrievalTrace: (r) => records.push(r),
      });
      // The real pipeline, not a reimplementation of it. Anything else would diagnose a system the
      // user is not running.
      await graphSearch(ctx.db, { ...options, ...vectors });

      const { returned, droppedAt, summary } = summarize(rel, records);
      return {
        vault: v.id,
        query: input.query,
        path: rel,
        returned,
        dropped_at: droppedAt,
        summary,
        stages: records.map((r) => ({
          stage: r.stage,
          present: r.present,
          chunks_present: r.chunksPresent,
          candidates_in: r.candidatesIn,
          candidates_out: r.candidatesOut,
          ...(r.score !== undefined ? { score: r.score } : {}),
          ...(r.rank !== undefined ? { rank: r.rank } : {}),
          ...(r.note !== undefined ? { note: r.note } : {}),
        })),
      };
    },
  });
}
