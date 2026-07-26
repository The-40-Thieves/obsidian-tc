// THE-452 — Domain 5 (Links / backlinks / graph), analytics half. Three read-only tools over the
// PERSISTED note graph (vault_edges), distinct from the six link tools next door which walk the
// filesystem: these answer structural questions about the vault as a whole rather than about one
// note's links.
//
// NOT THE RANKER. Nothing here is wired into retrieval, and `graph-analytics.test.ts` fails if any
// module under search/ imports the algorithms. PageRank correlates with in-degree, which this
// codebase deliberately SUPPRESSES (hub suppression), so re-introducing it as a positive ranking
// prior would be self-contradictory — and the community structure overlaps the MMR/cluster
// diversification THE-73/THE-393 already ship. These are new *capabilities*, not better retrieval.
//
// ACL: vault_edges stores vault-relative paths, so every edge whose EITHER endpoint is unreadable
// is dropped before the graph is built. Filtering the RESULT instead would leak structure — a
// betweenness score computed over notes the caller cannot see still describes them.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { tableExists } from "../../db/introspect";
import type { Database } from "../../db/types";
import {
  betweenness,
  buildGraph,
  edgeKey,
  findPath,
  type GraphEdge,
  louvain,
  pageRank,
} from "../../graph/analytics";
import type { ToolDefinition } from "../../mcp/registry";
import { readableRel } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "./define";

/**
 * Betweenness is O(V*E) — on a 10k-note vault with 50k edges that is 5×10^8 operations, which is
 * not something a synchronous MCP dispatch should ever attempt. The cap is enforced by REFUSING,
 * not by silently sampling: a centrality score computed over an arbitrary subgraph is a wrong
 * answer wearing the shape of a right one.
 */
const BETWEENNESS_MAX_NODES = 2000;

// ---------------------------------------------------------------------------------------------
// THE-417 Phase 1: declared output contracts, written from the RETURN STATEMENTS below (see
// graph/analytics.ts for the ScoredNode/Community/PathHop shapes these mirror).
// ---------------------------------------------------------------------------------------------

const ScoredNodeSchema = z.object({ path: z.string(), score: z.number() });

/** graph_centrality: two arms. The betweenness-refusal arm is deliberately NARROWER (no
 *  edges/results) rather than a union, per RULE 5 — `available` and `message` are absent
 *  entirely on the normal arm (conditional spread, not null), and `edges`/`results` absent
 *  entirely on the refusal arm. */
const GraphCentralityOutput = z.object({
  vault: z.string(),
  metric: z.enum(["pagerank", "betweenness"]),
  nodes: z.number(),
  // Present only on the BETWEENNESS_MAX_NODES refusal arm, and always `false` there in practice —
  // z.boolean() rather than z.literal(false) because the handler's plain `available: false` return
  // widens to `boolean` under TS's control-flow inference across the two arms.
  available: z.boolean().optional(),
  message: z.string().optional(),
  // Present only on the normal (non-refused) arm.
  edges: z.number().optional(),
  results: z.array(ScoredNodeSchema).optional(),
});

const CommunitySchema = z.object({ id: z.number(), paths: z.array(z.string()) });

const GraphCommunitiesOutput = z.object({
  vault: z.string(),
  nodes: z.number(),
  modularity: z.number(),
  meaningful: z.boolean(),
  // Set to the literal `undefined` in the handler when meaningful, which is why this is
  // `.optional()` rather than nullable — the key is dropped, not nulled, on the wire.
  note: z.string().optional(),
  community_count: z.number(),
  communities: z.array(CommunitySchema),
});

const PathHopSchema = z.object({ from: z.string(), to: z.string(), via: z.array(z.string()) });

const GraphPathBetweenOutput = z.object({
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  directed: z.boolean(),
  connected: z.boolean(),
  from_in_graph: z.boolean(),
  to_in_graph: z.boolean(),
  hops: z.array(PathHopSchema),
  length: z.number().nullable(),
});

interface EdgeRow {
  source_path: string;
  target_path: string;
  edge_type: string;
}

/** Read the ACL-visible edge set for a vault, plus the edge-type map for path rationales. */
function readEdges(
  db: Database,
  vaultId: string,
  isReadable: (rel: string) => boolean,
): { edges: GraphEdge[]; types: Map<string, string[]> } {
  if (!tableExists(db, "vault_edges")) return { edges: [], types: new Map() };
  const rows = db
    .prepare("SELECT source_path, target_path, edge_type FROM vault_edges WHERE vault_id = ?")
    .all(vaultId) as EdgeRow[];
  const edges: GraphEdge[] = [];
  const types = new Map<string, string[]>();
  for (const r of rows) {
    // BOTH endpoints must be readable: an edge is a statement about two notes, and keeping one
    // whose far end is denied still tells the caller that the denied note exists.
    if (!isReadable(r.source_path) || !isReadable(r.target_path)) continue;
    edges.push({ source: r.source_path, target: r.target_path });
    const k = edgeKey(r.source_path, r.target_path);
    const list = types.get(k) ?? [];
    if (!list.includes(r.edge_type)) list.push(r.edge_type);
    types.set(k, list);
  }
  return { edges, types };
}

// Takes no deps on purpose: these tools read only ctx.db and ctx.acl, so importing M1Deps from
// ./index would create a genuine import cycle (index -> here -> index) for a type this file never
// uses. The boundary gate caught it; dropping the parameter is the fix, not an exemption.
export function buildGraphAnalyticsTools(): ToolDefinition[] {
  return [
    defineTool({
      name: "graph_centrality",
      domain: "links",
      description:
        "Structural importance of notes in the persisted link graph (THE-452). metric 'pagerank' answers 'what do many notes point at' (power iteration, damping 0.85); metric 'betweenness' answers the different question 'what sits between otherwise disconnected areas' — a bridge note can score high on betweenness with only two links. ANALYTICS ONLY: these scores are never used for retrieval ranking. Notes outside your read scope are excluded from the graph entirely, not just from the output.",
      inputSchema: z
        .object({
          vault: VaultId,
          metric: z.enum(["pagerank", "betweenness"]).default("pagerank"),
          /** PageRank only: hide notes with fewer inbound links than this from the RESULT. */
          min_incoming_links: z.number().int().min(0).max(100).default(0),
          limit: z.number().int().positive().max(200).default(25),
        })
        .strict(),
      outputSchema: GraphCentralityOutput,
      requiredScopes: ["read:notes"],
      tags: ["links", "graph"],
      handler: (input, ctx) => {
        const { edges } = readEdges(ctx.db, input.vault, (rel) => readableRel(ctx.acl, rel));
        const graph = buildGraph(edges);
        if (input.metric === "betweenness" && graph.nodes.length > BETWEENNESS_MAX_NODES) {
          return {
            vault: input.vault,
            metric: input.metric,
            available: false,
            nodes: graph.nodes.length,
            message: `betweenness is O(V*E) and this graph has ${graph.nodes.length} nodes (cap ${BETWEENNESS_MAX_NODES}). Refusing rather than sampling: a centrality score over an arbitrary subgraph is a wrong answer in the shape of a right one. Use metric 'pagerank', which is linear per iteration.`,
          };
        }
        const scored =
          input.metric === "pagerank"
            ? pageRank(graph, { minIncomingLinks: input.min_incoming_links })
            : betweenness(graph);
        return {
          vault: input.vault,
          metric: input.metric,
          nodes: graph.nodes.length,
          edges: edges.length,
          results: scored.slice(0, input.limit),
        };
      },
    }),

    defineTool({
      name: "graph_communities",
      domain: "links",
      description:
        "Community detection over the persisted link graph (Louvain, THE-452). Partitions notes into clusters that link to each other more than to the rest of the vault. Deterministic: the same vault and seed always yield the same partition. ALWAYS read `meaningful` — a modularity below 0.3 means the partition is not distinguishable from chance, and presenting those clusters as 'your vault's topics' would be inventing structure. ANALYTICS ONLY, never used for retrieval ranking.",
      inputSchema: z
        .object({
          vault: VaultId,
          seed: z.number().int().default(42),
          /** Communities smaller than this are omitted from the listing (still counted). */
          min_size: z.number().int().min(1).max(100).default(1),
          limit: z.number().int().positive().max(100).default(20),
        })
        .strict(),
      outputSchema: GraphCommunitiesOutput,
      requiredScopes: ["read:notes"],
      tags: ["links", "graph"],
      handler: (input, ctx) => {
        const { edges } = readEdges(ctx.db, input.vault, (rel) => readableRel(ctx.acl, rel));
        const graph = buildGraph(edges);
        const { communities, modularity, meaningful } = louvain(graph, { seed: input.seed });
        const shown = communities.filter((c) => c.paths.length >= input.min_size);
        return {
          vault: input.vault,
          nodes: graph.nodes.length,
          modularity,
          meaningful,
          // The warning travels WITH the data rather than only in the tool description, because a
          // caller that reads only the result must still see it.
          note: meaningful
            ? undefined
            : "modularity < 0.3 — this partition is not meaningfully better than chance; do not present these as topics.",
          community_count: communities.length,
          communities: shown.slice(0, input.limit),
        };
      },
    }),

    defineTool({
      name: "graph_path_between",
      domain: "links",
      description:
        "Trace how one note connects to another through the persisted link graph (THE-452): the shortest chain of notes joining them, with the edge types behind each hop. Undirected by default, because a reader follows a backlink as readily as a link; directed:true answers the narrower 'can I reach B by following links out of A'. Returns connected:false when no chain exists within your read scope.",
      inputSchema: z
        .object({
          vault: VaultId,
          from: VaultPath,
          to: VaultPath,
          directed: z.boolean().default(false),
        })
        .strict(),
      outputSchema: GraphPathBetweenOutput,
      requiredScopes: ["read:notes"],
      tags: ["links", "graph"],
      handler: (input, ctx) => {
        const from = normalizeVaultPath(input.from);
        const to = normalizeVaultPath(input.to);
        const { edges, types } = readEdges(ctx.db, input.vault, (rel) => readableRel(ctx.acl, rel));
        const graph = buildGraph(edges);
        const hops = findPath(graph, from, to, { directed: input.directed, edgeTypes: types });
        return {
          vault: input.vault,
          from,
          to,
          directed: input.directed,
          connected: hops !== null,
          // A note may be absent from the graph because it has no links at all, or because it is
          // outside the caller's read scope. Reporting presence separately keeps "unlinked" and
          // "not connected to B" from looking like the same answer.
          from_in_graph: graph.index.has(from),
          to_in_graph: graph.index.has(to),
          hops: hops ?? [],
          length: hops?.length ?? null,
        };
      },
    }),
  ];
}
