// Domain 24 — plur read-API proxy (G2.1). Four READ-ONLY tools over the external,
// GLOBAL plur engram store: plur_recall (BM25), plur_recall_hybrid (BM25+vector RRF),
// plur_similarity_search (cosine), plur_get (by id). Writes (learn/capture/forget) are
// deliberately NOT exposed — obsidian-tc is not the authority over engram lifecycle.
// These take no `vault` argument (the engram store is global) and the read:plur scope
// (read family — no mutation, no HITL). openPlur degrades to plugin_missing with NO
// network call when plur is unconfigured; a configured-but-down endpoint degrades to
// plugin_unreachable via the transport. The bearer token is never logged or surfaced.
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { openPlur } from "../../plur/client";
import { defineTool } from "../m1/define";
import type { M5Deps } from "./shared";

const K = z.number().int().positive().max(50).default(10);

export function buildPlurTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "plur_recall",
      description: "BM25 keyword recall over the global plur engram store (read-only proxy).",
      inputSchema: z
        .object({ query: z.string().min(1), k: K, scope: z.string().optional() })
        .strict(),
      requiredScopes: ["read:plur"],
      handler: async (input) => {
        const client = openPlur(deps.plur);
        return client.request({
          method: "POST",
          path: "/recall",
          body: { query: input.query, k: input.k, ...(input.scope ? { scope: input.scope } : {}) },
          plugin: "plur",
        });
      },
    }),

    defineTool({
      name: "plur_recall_hybrid",
      description: "Hybrid BM25 + embedding recall (RRF) over the global plur engram store.",
      inputSchema: z
        .object({
          query: z.string().min(1),
          k: K,
          scope: z.string().optional(),
          bm25_weight: z.number().min(0).max(1).default(0.5),
        })
        .strict(),
      requiredScopes: ["read:plur"],
      handler: async (input) => {
        const client = openPlur(deps.plur);
        return client.request({
          method: "POST",
          path: "/recall_hybrid",
          body: {
            query: input.query,
            k: input.k,
            bm25_weight: input.bm25_weight,
            ...(input.scope ? { scope: input.scope } : {}),
          },
          plugin: "plur",
        });
      },
    }),

    defineTool({
      name: "plur_similarity_search",
      description: "Cosine similarity search over plur engram embeddings (read-only proxy).",
      inputSchema: z
        .object({
          query: z.string().min(1),
          k: K,
          scope: z.string().optional(),
          min_score: z.number().optional(),
        })
        .strict(),
      requiredScopes: ["read:plur"],
      handler: async (input) => {
        const client = openPlur(deps.plur);
        return client.request({
          method: "POST",
          path: "/similarity_search",
          body: {
            query: input.query,
            k: input.k,
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.min_score !== undefined ? { min_score: input.min_score } : {}),
          },
          plugin: "plur",
        });
      },
    }),

    defineTool({
      name: "plur_get",
      description: "Fetch a specific plur engram by id (read-only proxy).",
      inputSchema: z.object({ engram_id: z.string().min(1) }).strict(),
      requiredScopes: ["read:plur"],
      handler: async (input) => {
        const client = openPlur(deps.plur);
        return client.request({
          method: "POST",
          path: "/get",
          body: { engram_id: input.engram_id },
          plugin: "plur",
        });
      },
    }),
  ];
}
