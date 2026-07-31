// WP2.2: the `reflect` tool factory, extracted verbatim out of buildKnowledgeTools. Takes the
// shared retrieval runtime constructed once in buildKnowledgeTools rather than building its own
// embedder, cache, or policy state — see RetrievalRuntime's doc comment in retrieval-runtime.ts.
// `persistGovernedNote` stays inside this handler, inside the governed-write boundary: it must
// never be lifted out to run unconditionally or outside the write:notes scope check below.
import { err, grantsAll, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { challengeProposal, type EvidenceChunk, isDecisionChunk } from "../../../plane/challenge";
import { prompt } from "../../../plane/gateway";
import { buildEvidence } from "../../../search/evidence";
import type { GraphSearchResult } from "../../../search/graph_search";
import { cachedGraphSearch } from "../../../search/query_cache";
import { lexicalRouteResults, routeQuery } from "../../../search/router";
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { persistGovernedNote } from "../../../vault/persist-note";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import {
  buildGraphSearchOptions,
  CHALLENGE_EVIDENCE_BUDGET,
  cacheContextFor,
  capturePolicy,
  noteTagsByPath,
  openContradictionsForPaths,
  REFLECT_SYSTEM_PROMPT,
  type RetrievalRuntime,
  retrievalHits,
  SYNTHESIS_EVIDENCE_BUDGET,
} from "./retrieval-runtime";
import { ReflectOutput } from "./schemas";

export function createReflectTool(deps: M7Deps, retrieval: RetrievalRuntime): ToolDefinition {
  return defineTool({
    name: "reflect",
    domain: "knowledge",
    description:
      "The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance. mode 'challenge' runs the adversarial red-team over the decision-bearing recall instead (the knowledge_challenge core). persist: true writes the answer as a derived note under the memory folder's reflections/ with source_model + chunk provenance (requires write:notes). Degrades gracefully: without the inference gateway, recall still returns sources with available: false. The sleep-time half (episode-eligibility evaluator + preference profile) runs via the `obsidian-tc reflect` CLI command.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(3).max(4000),
        mode: z.enum(["synthesis", "challenge"]).default("synthesis"),
        k: z.number().int().positive().max(60).default(20),
        scope: z.string().min(1).optional(),
        persist: z.boolean().default(false),
      })
      .strict(),
    outputSchema: ReflectOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      // Same front door as every knowledge surface: the class router when enabled, the
      // measured engine otherwise. reflect composes recall + a generative pass — it never
      // adds a retrieval mechanism.
      const route = deps.classRouter
        ? routeQuery(ctx.db, v.id, input.query)
        : { class: "standard" as const, signals: [] as string[] };
      const policy = capturePolicy(deps, v.id, route.class);
      let results: GraphSearchResult[];
      if (route.class === "lexical") {
        results = lexicalRouteResults(ctx.db, v.id, input.query, input.k, (rel) =>
          readableRel(ctx.acl, rel),
        );
      } else {
        results = await cachedGraphSearch(
          ctx.db,
          buildGraphSearchOptions(deps, {
            route,
            query: input.query,
            vaultId: v.id,
            finalTopK: input.k,
            reranker: deps.reranker,
            isReadable: (rel) => readableRel(ctx.acl, rel),
            onFusionWeights: policy.sink,
          }),
          () => retrieval.embedAll(input.query, input.query),
          cacheContextFor(deps, ctx, v.id, input.query),
        );
      }
      if (input.scope !== undefined) {
        const scope = input.scope;
        results = results.filter((r) => r.path.startsWith(scope));
      }
      deps.retrievalLog?.({
        queryText: input.query,
        surfaceType: "reflect",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: retrievalHits(results),
        policy: policy.record(route.class === "lexical" ? "lexical-route" : "static"),
      });
      const sources = results.map((r) => ({
        chunk_id: r.chunk_id,
        path: r.path,
        score: r.rerank_score,
      }));
      if (!deps.roles) {
        return {
          vault: v.id,
          mode: input.mode,
          route: route.signals,
          available: false,
          message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
          answer: null,
          sources,
        };
      }
      if (input.mode === "challenge") {
        const paths = [...new Set(results.map((r) => r.path))];
        const tags = noteTagsByPath(ctx.db, v.id, paths);
        // Same shared builder and same budget as knowledge-challenge.ts — these two paths feed the
        // identical judge prompt and used to build their sets independently (this one sliced to
        // CHALLENGE_RECALL with no dedup; the other did not slice at all).
        const evidence: EvidenceChunk[] = buildEvidence(
          results
            .filter((r) => isDecisionChunk({ path: r.path, tags: tags.get(r.path) ?? null }))
            .map((r) => ({
              path: r.path,
              chunkId: r.chunk_id,
              tags: tags.get(r.path) ?? null,
              content: r.content ?? "",
            })),
          CHALLENGE_EVIDENCE_BUDGET,
        ).items;
        const contradictions = openContradictionsForPaths(ctx.db, v.id, paths, (rel) =>
          readableRel(ctx.acl, rel),
        );
        const { output, model } = await challengeProposal(
          deps.roles,
          input.query,
          evidence,
          contradictions,
        );
        return {
          vault: v.id,
          mode: "challenge",
          route: route.signals,
          available: true,
          model,
          challenge: output,
          sources,
        };
      }
      // Selection through the shared builder; the RENDER stays this path's terse
      // `[n] path\ncontent` shape rather than adopting challenge's `path:/headings:/tags:/content:`
      // envelope. Unifying the two prompts' wording would change what the synthesis model reads,
      // and prompt wording is an evaluated change here — the builder unifies WHICH chunks are shown
      // and how they are numbered, not how they are phrased.
      const synthesis = buildEvidence(
        results.map((r) => ({
          path: r.path,
          chunkId: r.chunk_id,
          content: r.content ?? "",
        })),
        SYNTHESIS_EVIDENCE_BUDGET,
      );
      const evidenceBlock = synthesis.items
        .map((e) => `[${e.citation}] ${e.path}\n${e.content}`)
        .join("\n\n");
      const res = await deps.roles.synthesize(
        prompt(
          REFLECT_SYSTEM_PROMPT,
          `Question:\n${input.query}\n\nEvidence chunks:\n${evidenceBlock}`,
        ),
      );
      // Traceable derived memory (the Hindsight "update in a traceable way" requirement):
      // provenance frontmatter carries the model + the exact source chunk ids and paths.
      let persisted: { path: string } | undefined;
      if (input.persist) {
        // Wildcard-aware, matching the dispatch path (registry.ts grantsAll): a caller holding
        // `*` or `write:*` satisfies write:notes. A raw Set `.has("write:notes")` rejected them
        // even though every other write tool accepts them (audit THE-562 / P1.6).
        if (!grantsAll(ctx.grantedScopes ?? [], ["write:notes"]))
          throw err.forbidden("reflect persist requires write:notes");
        const folder = deps.memoryFolder?.(v.id) ?? "memory";
        const slug =
          input.query
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "reflection";
        const nowMs = (ctx.now ?? Date.now)();
        const rel = `${folder}/reflections/${new Date(nowMs).toISOString().slice(0, 10)}-${slug}.md`;
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const content = [
          "---",
          `generated_at: ${new Date(nowMs).toISOString()}`,
          `source_model: ${res.model}`,
          `query: ${JSON.stringify(input.query)}`,
          `source_chunks: ${JSON.stringify(results.slice(0, 20).map((r) => r.chunk_id))}`,
          `source_paths: ${JSON.stringify([...new Set(results.slice(0, 20).map((r) => r.path))])}`,
          "---",
          "",
          res.text,
          "",
        ].join("\n");
        persistGovernedNote(
          ctx.db,
          { snapshots: deps.snapshots, reindex: deps.reindex, now: ctx.now ?? Date.now },
          { vaultId: v.id, root: v.root, rel, content, op: "reflect_persist", createDirs: true },
        );
        persisted = { path: rel };
      }
      return {
        vault: v.id,
        mode: "synthesis",
        route: route.signals,
        available: true,
        answer: res.text,
        model: res.model,
        sources,
        ...(persisted ? { persisted } : {}),
      };
    },
  });
}
