// WP2.3: the `knowledge_challenge` tool factory, extracted verbatim out of buildKnowledgeTools.
// Takes the shared retrieval runtime constructed once in buildKnowledgeTools rather than building
// its own embedder, cache, or policy state — see RetrievalRuntime's doc comment in
// retrieval-runtime.ts. Uses only retrieval.embedQuery (a dense-only recall, no fusion, so it
// never reaches embedAll/embedQuerySparse/embedQueryColbert).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { challengeProposal } from "../../../plane/challenge";
import { vaultExclusionFor, withVaultExclusion } from "../../../search/index-exclusion";
import { semanticSearch } from "../../../search/semantic";
import { readableRel } from "../../../vault/acl-read-filter";
import { readableStoredRow } from "../../../vault/stored-acl-path";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import {
  CHALLENGE_EXPANDED_RECALL,
  CHALLENGE_RECALL,
  noteTagsByPath,
  openContradictionsForPaths,
  type RetrievalRuntime,
  selectChallengeEvidence,
  shouldExpandChallengeRecall,
  withCitationCheck,
} from "./retrieval-runtime";
import { KnowledgeChallengeOutput } from "./schemas";

export function createKnowledgeChallengeTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
): ToolDefinition {
  return defineTool({
    name: "knowledge_challenge",
    domain: "knowledge",
    description:
      "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses, or notes tagged decision, audit, self-audit, outcome, postmortem, reversal, lesson, review, analysis) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. That decision rule is fixed, not per-vault: a vault whose folders and tags match neither list gets no evidence, and coverage reports recalled and filtered_out counts so the cause is visible. Open contradictions are supplied only when the plane is enabled (plane.enabled). Cited paths are checked against the evidence shown; unseen ones are listed in coverage.unresolved_evidence_paths. Requires the gateway; reports unavailable when it is not configured.",
    inputSchema: z
      .object({
        vault: VaultId,
        proposal: z.string().min(10).max(4000),
      })
      .strict(),
    outputSchema: KnowledgeChallengeOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "external-network"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      if (!deps.roles) {
        return {
          vault: v.id,
          available: false,
          message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
        };
      }
      const isReadable = withVaultExclusion(
        readableStoredRow(ctx.db, v.id, (a) => readableRel(ctx.acl, a, ctx.grantedScopes)),
        vaultExclusionFor(deps.vaultRegistry, v.id),
      );
      const queryVec = await retrieval.embedQuery(input.proposal);
      const recall = (k: number) =>
        semanticSearch(ctx.db, v.id, queryVec, {
          k,
          returnContent: true,
          isReadable,
          model: deps.embeddingProvider.id, // THE-530: constrain to the active model
        });
      const select = (hits: ReturnType<typeof recall>) => {
        const tagsByPath = noteTagsByPath(ctx.db, v.id, [...new Set(hits.map((h) => h.path))]);
        return selectChallengeEvidence(
          hits.map((h) => ({
            path: h.path,
            content: h.content ?? "",
            chunkId: h.chunk_id,
            tags: tagsByPath.get(h.path) ?? [],
          })),
        );
      };
      let hits = recall(CHALLENGE_RECALL);
      let selected = select(hits);
      if (shouldExpandChallengeRecall(hits.length, selected.coverage)) {
        hits = recall(CHALLENGE_EXPANDED_RECALL);
        selected = select(hits);
      }
      // THE-230: challenge recall is a real retrieval surface — log it like the search tools.
      deps.retrievalLog?.({
        queryText: input.proposal,
        surfaceType: "knowledge_challenge",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: hits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, score: h.score })),
        // THE-538: challenge recall is a bare dense scan (semanticSearch), not a fusion — there
        // is no stream to attribute a hit to and no lexical/sparse weight to record. Saying so
        // explicitly is the point: a NULL here must read as "this policy has no such weight",
        // never as "we forgot to log it".
        policy: {
          vaultId: v.id,
          policyId: "dense-only",
          denseW: 1,
          lexW: null,
          sparseW: null,
          fusionMode: null,
          rrfK: null,
          routeClass: null,
        },
      });
      // Selection goes through the shared selector (retrieval-runtime.ts) so this path and reflect.ts's
      // challenge mode cannot drift on the decision filter, dedup, per-note quota, trimming or citation
      // numbering. `chunk_id` is threaded so dedup keys on retrieval identity rather than on text.
      const { evidence, coverage } = selected;
      if (evidence.length === 0) {
        return {
          vault: v.id,
          available: true,
          evidence_count: 0,
          output: null,
          message: `no decision-bearing chunks matched this proposal (${coverage.recalled} recalled, ${coverage.filtered_out} failed the decision filter)`,
          coverage,
        };
      }
      // Open contradictions touching the evidence give the judge cross-note conflict context.
      const contradictions = openContradictionsForPaths(
        ctx.db,
        v.id,
        evidence.map((e) => e.path),
        isReadable,
      );
      const { output, model, excludedCount, citations } = await challengeProposal(
        deps.roles,
        input.proposal,
        evidence,
        contradictions,
        deps.excludeFilter,
      );
      return {
        vault: v.id,
        available: true,
        evidence_count: evidence.length,
        contradiction_count: contradictions.length,
        output,
        model,
        coverage: withCitationCheck(coverage, citations),
        ...(excludedCount > 0 ? { excluded_count: excludedCount } : {}),
      };
    },
  });
}
