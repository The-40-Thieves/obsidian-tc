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
// caller cannot read leaks both the path's existence and its similarity to the query. Exactly ONE
// thing makes that safe, and it is stated precisely here because an earlier version of this comment
// claimed a second one that the code deliberately does not have:
//
//   `isReadable` is threaded into every arm AT QUERY TIME — dense, lexical and sparse in
//   seed_generation (THE-287 for dense, THE-632 for the other two), plus graph expansion's own
//   walk. Every array the trace inspects is therefore ACL-filtered before it exists, an unreadable
//   note is genuinely absent from all of them, and it falls out as the REAL never-a-candidate
//   answer rather than a manufactured one.
//
// There is deliberately NO up-front readability check on the target path, and this comment
// previously said there was. That earlier version short-circuited with a hand-written envelope, and
// cross-vendor review showed it was trivially distinguishable from a genuinely-unmatched readable
// path — see the four tells at the handler. Query-time filtering is consequently the ONLY mechanism
// providing this property. Do not thin it out on the assumption that a branch in the handler is
// backstopping it; nothing is.
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
  // NEVER-A-CANDIDATE is "absent at EVERY traced stage", not "absent at the first one".
  //
  // That distinction is a regression I introduced and did not catch. Before seedGeneration was
  // traced, records[0] WAS candidateAssembly, so absence there did mean never-a-candidate. Adding
  // the earlier trace silently invalidated the assumption: a note reached only through GRAPH
  // EXPANSION is legitimately absent at seedGeneration and present immediately after. The old
  // check reported "never entered the candidate pool" for exactly the multi-hop retrieval this
  // engine exists to do, and blamed seedGeneration for a drop that happened at diversity.
  //
  // Caught from the adversarial test case a re-review was building when its run was cut short —
  // seedGeneration:absent, graphExpansion:present, ... diversity:absent. Pinned below.
  const everPresent = records.some((r) => r.present);
  if (!everPresent) {
    const checked = records
      .filter((r) => !r.present && (r.stage === "seedGeneration" || r.stage === "graphExpansion"))
      .map((r) => r.stage);
    const arms =
      checked.length > 0
        ? ` Absent at: ${checked.join(", ")} — see each stage's note below for what that rules out.`
        : "";
    // Name candidateAssembly when it was traced — that is the stage where "candidate" is decided.
    // Falling back to the first record keeps this honest if the trace set ever changes again.
    const pool = records.find((r) => r.stage === "candidateAssembly") ?? records[0];
    return {
      returned: false,
      droppedAt: pool?.stage ?? null,
      summary: `${path} never entered the candidate pool, so no later stage ever scored it.${arms} Check that the note is indexed and that the query shares vocabulary or a link path with it.`,
    };
  }
  // The drop is the first absence AFTER the note was seen — searching from index 0 would name a
  // stage the note had not reached yet (seedGeneration for an expansion-only hit).
  const firstPresent = records.findIndex((r) => r.present);
  const dropIdx = records.findIndex((r, i) => i > firstPresent && !r.present);
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

      // NO early return for an unreadable path — deliberately, and this is the second version of
      // this code. The first short-circuited with a hand-written "never a candidate" envelope, and
      // cross-vendor review showed that was trivially distinguishable from a genuinely-unmatched
      // readable path: `stages: []` instead of real records, a summary missing the arm-list
      // parenthetical, no embedding call (so far lower latency), and during a provider outage a
      // clean error oracle — readable paths error, unreadable ones return success.
      //
      // Running the SAME pipeline is what makes the two observationally equivalent, and it is only
      // sound because every arm is now ACL-filtered AT QUERY TIME (seed_generation threads
      // isReadable into the dense, lexical and sparse arms; graph expansion filters in its walk).
      // An unreadable note is therefore genuinely absent from every traced array, and produces the
      // real never-a-candidate answer rather than a manufactured one. Padding the response or
      // adding an artificial delay would not have worked: the error behaviour would still differ.
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
