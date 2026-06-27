// M7 — the knowledge domain (THE-233 integration). Exposes the folded retrieval-intelligence
// as MCP tools now that vault_edges (W-SCHEMA, populated by W-INGEST) and the gateway seams are
// on the branch: vault_graph_search (W-RETRIEVAL GraphRAG) and knowledge_challenge (W-WORKERS
// red-team core). Both degrade gracefully when the inference gateway is unconfigured.
// knowledge_get_critical is intentionally absent (vendor-KB data model not in the tree).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import type { EmbeddingProvider } from "../../embeddings";
import type { ToolDefinition } from "../../mcp/registry";
import { challengeProposal, isDecisionChunk } from "../../plane/challenge";
import type { GatewayRoles } from "../../plane/gateway";
import { graphSearch } from "../../search/graph_search";
import type { Reranker } from "../../search/rerank";
import { semanticSearch } from "../../search/semantic";
import type { VaultRegistry } from "../../vault/registry";
import { defineTool } from "../m1/define";

export interface M7Deps {
  vaultRegistry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
  /** Rerank seam → gateway /rerank passthrough; null when the gateway is unconfigured. */
  reranker: Reranker | null;
  /** Generative roles → gateway extract/synthesize/judge; null when unconfigured. */
  roles: GatewayRoles | null;
}

function aclReadable(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl?.readPaths) return true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

const CHALLENGE_RECALL = 30;

export function buildKnowledgeTools(deps: M7Deps): ToolDefinition[] {
  const embedQuery = async (q: string): Promise<number[]> => {
    const [vec] = await deps.embeddingProvider.embed([q]);
    return vec ?? [];
  };

  return [
    defineTool({
      name: "vault_graph_search",
      description:
        "Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed|expansion with hop + via_edge.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          final_top_k: z.number().int().positive().max(100).default(30),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      tags: ["knowledge", "search"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const queryVec = await embedQuery(input.query);
        const results = await graphSearch(ctx.db, {
          query: input.query,
          queryVec,
          vaultId: v.id,
          finalTopK: input.final_top_k,
          reranker: deps.reranker,
          isReadable: (rel) => aclReadable(ctx.acl, rel),
        });
        return { vault: v.id, mode_used: "graph", results };
      },
    }),

    defineTool({
      name: "knowledge_challenge",
      description:
        "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured.",
      inputSchema: z
        .object({
          vault: VaultId,
          proposal: z.string().min(10).max(4000),
        })
        .strict(),
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
        const queryVec = await embedQuery(input.proposal);
        const evidence = semanticSearch(ctx.db, v.id, queryVec, {
          k: CHALLENGE_RECALL,
          returnContent: true,
          isReadable: (rel) => aclReadable(ctx.acl, rel),
        })
          .filter((h) => isDecisionChunk({ path: h.path }))
          .map((h) => ({ path: h.path, content: h.content ?? "" }));
        if (evidence.length === 0) {
          return {
            vault: v.id,
            available: true,
            evidence_count: 0,
            output: null,
            message: "no decision-bearing chunks matched this proposal",
          };
        }
        const { output, model } = await challengeProposal(deps.roles, input.proposal, evidence, []);
        return { vault: v.id, available: true, evidence_count: evidence.length, output, model };
      },
    }),
  ];
}
