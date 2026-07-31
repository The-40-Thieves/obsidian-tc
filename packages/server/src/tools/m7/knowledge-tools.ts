// M7 — the knowledge domain (THE-233 integration). Exposes the folded retrieval-intelligence
// as MCP tools now that vault_edges (W-SCHEMA, populated by W-INGEST) and the gateway seams are
// on the branch: vault_graph_search (W-RETRIEVAL GraphRAG) and knowledge_challenge (W-WORKERS
// red-team core). Both degrade gracefully when the inference gateway is unconfigured.
// knowledge_get_critical is intentionally absent (vendor-KB data model not in the tree).
//
// WP2 slice 1: this file is now a compatibility facade over ./knowledge/*. The 11 output schema
// consts live in knowledge/schemas.ts, M7Deps in knowledge/deps.ts, and the shared retrieval
// helpers (cache-key/policy/coverage capture, budget packing, the graphSearch options builder,
// the tag/contradiction lookups) in knowledge/retrieval-runtime.ts. Every name this file
// exported before that split (M7Deps, packBudget, buildGraphSearchOptions, noteTagsByPath,
// openContradictionsForPaths, buildKnowledgeTools) is still exported from here, so no consumer
// needs to change its import path.
//
// WP2 slice 2: the two largest tool factories — vault_context (~348 lines) and reflect
// (~167 lines) — moved to knowledge/vault-context.ts and knowledge/reflect.ts as
// createVaultContextTool(deps, retrieval) / createReflectTool(deps, retrieval).
//
// WP2 slice 3 (completes WP2): the remaining five tools moved the same way —
// vault_graph_search and knowledge_search to knowledge/graph-search.ts and
// knowledge/knowledge-search.ts (both take `retrieval`, both call retrieval.embedAll on their
// graph-search paths), knowledge_challenge to knowledge/knowledge-challenge.ts (takes
// `retrieval`, but only ever calls retrieval.embedQuery — a dense-only recall, never embedAll),
// and knowledge_get_critical / list_contradictions to knowledge/knowledge-critical.ts and
// knowledge/contradictions.ts (neither takes `retrieval` — a frontmatter pre-filter and a table
// read respectively, neither one embeds a query).
//
// This file is now pure composition: it constructs the shared retrieval state (the
// embedQuery/embedQuerySparse/embedQueryColbert/embedAll closures) exactly once and hands that
// same `RetrievalRuntime` object to every factory that declares it — no factory builds its own
// embedder, cache, or policy state.
import type { ToolDefinition } from "../../mcp/registry";
import type { QueryVectors } from "../../search/query_cache";
import { createContradictionsTool } from "./knowledge/contradictions";
import type { M7Deps } from "./knowledge/deps";
import { createGraphSearchTool } from "./knowledge/graph-search";
import { createKnowledgeChallengeTool } from "./knowledge/knowledge-challenge";
import { createKnowledgeCriticalTool } from "./knowledge/knowledge-critical";
import { createKnowledgeSearchTool } from "./knowledge/knowledge-search";
import { createReflectTool } from "./knowledge/reflect";
import {
  buildGraphSearchOptions,
  noteTagsByPath,
  openContradictionsForPaths,
  packBudget,
  type RetrievalRuntime,
} from "./knowledge/retrieval-runtime";
import { createVaultContextTool } from "./knowledge/vault-context";
import { resolveQueryColbert, resolveQuerySparse } from "./query-sparse";

export type { M7Deps };
export { buildGraphSearchOptions, noteTagsByPath, openContradictionsForPaths, packBudget };

export function buildKnowledgeTools(deps: M7Deps): ToolDefinition[] {
  const embedQuery = async (q: string): Promise<number[]> => {
    const [vec] = await deps.embeddingProvider.embed([q], { input: "query" });
    return vec ?? [];
  };
  const embedQuerySparse = (q: string) =>
    resolveQuerySparse(deps.embeddingProvider, q, deps.retrieval?.sparse);
  const embedQueryColbert = (q: string) =>
    resolveQueryColbert(deps.embeddingProvider, q, deps.retrieval?.colbert);
  /**
   * THE-497: the three query encodings as one bundle, invoked ONLY on a cache miss — which is why
   * every retrieval site below passes this as a thunk rather than awaiting it first. `denseText`
   * and `lexicalText` are the same string everywhere except the THE-451 HyDE path, where the dense
   * arm embeds the hypothetical answer and the lexical/late-interaction arms must not.
   *
   * Absent heads are OMITTED rather than set to undefined: graphSearch distinguishes "unset" from
   * "set to undefined" nowhere, but the cache key does — an explicit undefined would be dropped by
   * the canonicaliser anyway, and omitting keeps the two representations identical by construction.
   */
  const embedAll = async (denseText: string, lexicalText: string): Promise<QueryVectors> => {
    const queryVec = await embedQuery(denseText);
    const querySparse = await embedQuerySparse(lexicalText);
    const queryColbert = await embedQueryColbert(lexicalText);
    return {
      queryVec,
      ...(querySparse ? { querySparse } : {}),
      ...(queryColbert ? { queryColbert } : {}),
    };
  };
  // WP2.2: the single shared retrieval-runtime object, constructed exactly once here and handed to
  // every extracted tool factory below. No factory builds its own embedder, cache, or policy
  // state — they compose entirely on this object, so a cache hit (which never calls embedAll) stays
  // a cache hit no matter which factory reached it through.
  const retrieval: RetrievalRuntime = { embedQuery, embedQuerySparse, embedQueryColbert, embedAll };

  return [
    createVaultContextTool(deps, retrieval),
    createReflectTool(deps, retrieval),
    createGraphSearchTool(deps, retrieval),
    createKnowledgeSearchTool(deps, retrieval),
    createKnowledgeCriticalTool(deps),
    createKnowledgeChallengeTool(deps, retrieval),
    createContradictionsTool(deps),
  ];
}
