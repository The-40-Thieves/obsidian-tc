// M7 — the knowledge domain (THE-233 integration). Exposes the folded retrieval-intelligence
// as MCP tools now that vault_edges (W-SCHEMA, populated by W-INGEST) and the gateway seams are
// on the branch: vault_graph_search (W-RETRIEVAL GraphRAG) and knowledge_challenge (W-WORKERS
// red-team core). Both degrade gracefully when the inference gateway is unconfigured.
// knowledge_get_critical is intentionally absent (vendor-KB data model not in the tree).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch, isDefaultDenied } from "../../acl";
import type { Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import type { RetrievalLogger } from "../../experiential/log";
import type { ToolDefinition } from "../../mcp/registry";
import {
  type ContradictionContext,
  challengeProposal,
  isDecisionChunk,
} from "../../plane/challenge";
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
  /** THE-397: config-driven retrieval knobs (config.retrieval); absent -> graphSearch defaults. */
  retrieval?: { rrfK?: number };
  /** THE-230: serve-path retrieval logging into the experiential store; absent -> no logging. */
  retrievalLog?: RetrievalLogger;
}

function aclReadable(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl) return true;
  if (isDefaultDenied(rel)) return false;
  if (!acl.readPaths) return acl.strictReadDefault !== true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

const CHALLENGE_RECALL = 30;

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Note-level frontmatter tags for the given paths (THE-309), so isDecisionChunk's tag rule can
 *  fire on the retrieved evidence — the semantic hit itself carries no tags. Scoped to the vault. */
export function noteTagsByPath(
  db: Database,
  vaultId: string,
  paths: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (paths.length === 0 || !tableExists(db, "notes")) return out;
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT path, tags FROM notes WHERE vault_id = ? AND path IN (${placeholders})`)
    .all(vaultId, ...paths) as Array<{ path: string; tags: string }>;
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        out.set(
          r.path,
          parsed.filter((t): t is string => typeof t === "string"),
        );
      }
    } catch {
      // malformed tags JSON — treat the note as untagged rather than failing the challenge.
    }
  }
  return out;
}

/** Open contradictions whose source or conflict note is in `paths` (THE-309) — gives the judge
 *  cross-note conflict context alongside the evidence. Empty when the plane table is absent. */
export function openContradictionsForPaths(db: Database, paths: string[]): ContradictionContext[] {
  if (paths.length === 0 || !tableExists(db, "contradictions")) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions
       WHERE status = 'open' AND (source_path IN (${placeholders}) OR conflict_path IN (${placeholders}))`,
    )
    .all(...paths, ...paths) as Array<{
    id: string;
    source_path: string;
    conflict_path: string;
    judge_verdict: string;
    judge_rationale: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    source_path: r.source_path,
    conflict_path: r.conflict_path,
    judge_verdict: r.judge_verdict,
    judge_rationale: r.judge_rationale ?? "",
  }));
}

export function buildKnowledgeTools(deps: M7Deps): ToolDefinition[] {
  const embedQuery = async (q: string): Promise<number[]> => {
    const [vec] = await deps.embeddingProvider.embed([q], { input: "query" });
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
          ...(deps.retrieval?.rrfK !== undefined ? { rrfK: deps.retrieval.rrfK } : {}),
          reranker: deps.reranker,
          isReadable: (rel) => aclReadable(ctx.acl, rel),
        });
        // THE-230: serve-path retrieval telemetry (best-effort; the logger never throws).
        deps.retrievalLog?.({
          queryText: input.query,
          surfaceType: "vault_graph_search",
          hits: results.map((r, i) => ({
            chunkId: r.chunk_id,
            rank: i + 1,
            score: r.rerank_score,
          })),
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
        const hits = semanticSearch(ctx.db, v.id, queryVec, {
          k: CHALLENGE_RECALL,
          returnContent: true,
          isReadable: (rel) => aclReadable(ctx.acl, rel),
        });
        // THE-230: challenge recall is a real retrieval surface — log it like the search tools.
        deps.retrievalLog?.({
          queryText: input.proposal,
          surfaceType: "knowledge_challenge",
          hits: hits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, score: h.score })),
        });
        // Enrich with note-level tags so isDecisionChunk's tag rule fires (not just the path
        // prefix) and the judge sees the tags; the semantic hit itself carries no tags (THE-309).
        const tagsByPath = noteTagsByPath(ctx.db, v.id, [...new Set(hits.map((h) => h.path))]);
        const evidence = hits
          .map((h) => ({
            path: h.path,
            content: h.content ?? "",
            tags: tagsByPath.get(h.path) ?? [],
          }))
          .filter((e) => isDecisionChunk({ path: e.path, tags: e.tags }));
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
          evidence.map((e) => e.path),
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
    }),
  ];
}
