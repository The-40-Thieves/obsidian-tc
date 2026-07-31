// WP2.3: the `knowledge_challenge` tool factory, extracted verbatim out of buildKnowledgeTools.
// Takes the shared retrieval runtime constructed once in buildKnowledgeTools rather than building
// its own embedder, cache, or policy state — see RetrievalRuntime's doc comment in
// retrieval-runtime.ts. Uses only retrieval.embedQuery (a dense-only recall, no fusion, so it
// never reaches embedAll/embedQuerySparse/embedQueryColbert).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { challengeProposal, isDecisionChunk } from "../../../plane/challenge";
import { buildEvidence } from "../../../search/evidence";
import { semanticSearch } from "../../../search/semantic";
import { readableRel } from "../../../vault/acl-read-filter";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import {
  CHALLENGE_EVIDENCE_BUDGET,
  CHALLENGE_RECALL,
  noteTagsByPath,
  openContradictionsForPaths,
  type RetrievalRuntime,
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
      "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured.",
    inputSchema: z
      .object({
        vault: VaultId,
        proposal: z.string().min(10).max(4000),
      })
      .strict(),
    outputSchema: KnowledgeChallengeOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      if (!deps.roles) {
        return {
          vault: v.id,
          available: false,
          message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
        };
      }
      const queryVec = await retrieval.embedQuery(input.proposal);
      const hits = semanticSearch(ctx.db, v.id, queryVec, {
        k: CHALLENGE_RECALL,
        returnContent: true,
        isReadable: (rel) => readableRel(ctx.acl, rel),
        model: deps.embeddingProvider.id, // THE-530: constrain to the active model
      });
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
      // Enrich with note-level tags so isDecisionChunk's tag rule fires (not just the path
      // prefix) and the judge sees the tags; the semantic hit itself carries no tags (THE-309).
      const tagsByPath = noteTagsByPath(ctx.db, v.id, [...new Set(hits.map((h) => h.path))]);
      // Selection goes through the shared builder (search/evidence.ts) so this path and reflect.ts's
      // challenge mode cannot drift on dedup, per-note quota, trimming or citation numbering — they
      // used to assemble their own sets and only agreed by coincidence. `chunk_id` is threaded so
      // dedup keys on retrieval identity rather than on text.
      const built = buildEvidence(
        hits
          .map((h) => ({
            path: h.path,
            content: h.content ?? "",
            chunkId: h.chunk_id,
            tags: tagsByPath.get(h.path) ?? [],
          }))
          .filter((e) => isDecisionChunk({ path: e.path, tags: e.tags })),
        CHALLENGE_EVIDENCE_BUDGET,
      );
      const evidence = built.items;
      if (evidence.length === 0) {
        return {
          vault: v.id,
          available: true,
          evidence_count: 0,
          output: null,
          message: "no decision-bearing chunks matched this proposal",
        };
      }
      // Open contradictions touching the evidence give the judge cross-note conflict context.
      const contradictions = openContradictionsForPaths(
        ctx.db,
        v.id,
        evidence.map((e) => e.path),
        (rel) => readableRel(ctx.acl, rel),
      );
      const { output, model } = await challengeProposal(
        deps.roles,
        input.proposal,
        evidence,
        contradictions,
      );
      return {
        vault: v.id,
        available: true,
        evidence_count: evidence.length,
        contradiction_count: contradictions.length,
        output,
        model,
      };
    },
  });
}
