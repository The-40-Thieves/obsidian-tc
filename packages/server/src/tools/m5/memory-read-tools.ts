// Domain 22 — Memory entities + [[link]] graph (G2.1), READ half: get_entity, query_entity_graph.
// Split out of memory-tools.ts (which owns create_entity/add_observation/link_entities, the
// memoryDefense-guarded WRITE half) purely to stay under biome's 700-line file ceiling — both
// files share memory-projection.ts's materialization helpers so neither imports the other, and
// this file's two tools never scan/enforce memoryDefense: they read, never persist.
import { err, Pagination, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import {
  bfsGraph,
  type EntityRow,
  findEntitiesByName,
  findEntity,
  getEntityById,
  type ObservationView,
  observationsAsOf,
  relationsForEntity,
} from "../../memory/entities";
import { defineTool } from "../m1/define";
import type { M5Deps } from "./shared";

/** THE-833: an entity is visible unless it's retired and the caller didn't opt in. Shared by
 *  get_entity (single lookup + the by-name ambiguity candidates) and query_entity_graph (the BFS
 *  result set) so "filtered by default" means the same thing in both places. */
function isVisible(e: Pick<EntityRow, "status">, includeRetired: boolean): boolean {
  return includeRetired || e.status !== "retired";
}

// THE-1130: one observation, as returned to a caller — the wire shape both tools here emit, so
// "what a fact looks like on the wire" has exactly one definition. zod's safeParse silently
// strips an undeclared field and reports success — every field ObservationView carries is
// declared here, none silently dropped at the MCP boundary.
const ObservationSchema = z.object({
  text: z.string(),
  key: z.string().nullable(),
  valid_from: z.number(),
  valid_to: z.number().nullable(),
  superseded_by: z.string().nullable(),
});

function toObservationOutput(o: ObservationView): z.infer<typeof ObservationSchema> {
  return {
    text: o.text,
    key: o.key,
    valid_from: o.validFrom,
    valid_to: o.validTo,
    superseded_by: o.supersededBy,
  };
}

const EntityRelation = z.object({
  target_id: z.string(),
  target_name: z.string(),
  target_type: z.string(),
  relation_type: z.string(),
  direction: z.enum(["out", "in"]),
});

const GetEntityOutput = z.object({
  entity_id: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(["active", "retired"]),
  // THE-1130: observations valid `as_of` the input (default: now) — see add_observation's own
  // schema for what valid_from/valid_to/superseded_by mean on each one.
  observations: z.array(ObservationSchema),
  relations: z.array(EntityRelation),
  vault_path: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  as_of: z.number(),
});

const GraphNodeItem = z.object({
  entity_id: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(["active", "retired"]),
  distance: z.number(),
  // bfsGraph's GraphNode.path: the hop-by-hop trail from the seed, not a vault path.
  path: z.array(z.object({ via_entity_id: z.string(), via_relation: z.string() })),
  // THE-1130: each node's own observations, valid `as_of` the query's as_of (default: now) — same
  // shape and same filter get_entity applies, so "what did we believe as_of D" answers the same
  // way whether reached by a direct get_entity or by a graph traversal that passes through it.
  observations: z.array(ObservationSchema),
});

const QueryEntityGraphOutput = z.object({
  vault: z.string(),
  as_of: z.number(),
  seed_entity_id: z.string(),
  items: z.array(GraphNodeItem),
  next_cursor: z.string().nullable(),
  total_returned: z.number(),
});

export function buildMemoryReadTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_entity",
      domain: "knowledge",
      description:
        "Read a memory entity by id, by type+name, or by unique name, with its observations and relations. Retired entities are hidden unless include_retired is set. Observations returned are filtered by as_of — a fact is included when valid_from <= as_of and (valid_to is unset or as_of < valid_to). Default as_of is now, so an as_of in the PAST excludes any observation added after that instant, even one that is still open today.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
          include_retired: z.boolean().default(false),
          as_of: z.number().int().nonnegative().optional(),
        })
        .strict(),
      outputSchema: GetEntityOutput,
      requiredScopes: ["read:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        let e: EntityRow | undefined;
        if (input.entity_id) {
          const found = getEntityById(ctx.db, input.entity_id);
          e = found && found.vault_id === v.id ? found : undefined;
        } else if (input.type && input.name) {
          e = findEntity(ctx.db, v.id, input.type, input.name);
        } else if (input.name) {
          // THE-833: a retired entity sharing a name with an active one should not count toward
          // ambiguity when the caller hasn't opted in to see retired entities at all — filter the
          // candidate set FIRST, the same order get_entity applies the filter to a resolved `e`.
          const hits = findEntitiesByName(ctx.db, v.id, input.name).filter((h) =>
            isVisible(h, input.include_retired),
          );
          if (hits.length > 1)
            throw err.invalidInput("entity name is ambiguous; provide type", {
              name: input.name,
              candidates: hits.map((h) => ({ entity_id: h.id, type: h.entity_type })),
            });
          e = hits[0];
        } else {
          throw err.invalidInput("provide entity_id, or type+name, or name");
        }
        if (!e || !isVisible(e, input.include_retired))
          throw err.invalidInput("entity not found", { vault: v.id });
        const relations = relationsForEntity(ctx.db, e.id).map((r) => ({
          target_id: r.other_id,
          target_name: r.other_name,
          target_type: r.other_type,
          relation_type: r.relation_type,
          direction: r.direction,
        }));
        const asOf = input.as_of ?? (ctx.now ?? Date.now)();
        return {
          entity_id: e.id,
          type: e.entity_type,
          name: e.name,
          status: e.status,
          observations: observationsAsOf(ctx.db, e, asOf).map(toObservationOutput),
          relations,
          vault_path: e.vault_path,
          created_at: e.created_at,
          updated_at: e.updated_at,
          as_of: asOf,
        };
      },
    }),

    defineTool({
      name: "query_entity_graph",
      domain: "knowledge",
      description:
        "Traverse the memory graph from a seed entity (BFS, depth-limited, type/direction filtered). Retired entities are excluded from the seed and the result set unless include_retired is set — traversal still walks THROUGH a retired node to reach its neighbors, only the returned/visible set is filtered. Each returned node's observations are filtered by as_of (default now — see get_entity's own description for the exact rule), so a graph walk answers 'what did we believe as_of D' the same way a direct get_entity does. Domain: knowledge.",
      inputSchema: z
        .object({
          vault: VaultId,
          seed_entity_id: z.string().min(1),
          depth: z.number().int().positive().max(5).optional(),
          relation_types: z.array(z.string()).optional(),
          entity_types: z.array(z.string()).optional(),
          direction: z.enum(["out", "in", "both"]).default("both"),
          include_retired: z.boolean().default(false),
          as_of: z.number().int().nonnegative().optional(),
        })
        .merge(Pagination)
        .strict(),
      outputSchema: QueryEntityGraphOutput,
      requiredScopes: ["read:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const seed = getEntityById(ctx.db, input.seed_entity_id);
        if (!seed || seed.vault_id !== v.id || !isVisible(seed, input.include_retired))
          throw err.invalidInput("seed entity not found", { seed_entity_id: input.seed_entity_id });
        const allNodes = bfsGraph(ctx.db, seed.id, {
          depth: input.depth,
          direction: input.direction,
          relationTypes: input.relation_types,
          entityTypes: input.entity_types,
        });
        // THE-833: filter AFTER the walk, not during it (unlike bfsGraph's own entity_types/
        // relation_types filters, which prune mid-traversal and so can make a downstream node
        // unreachable through a filtered-out one). A retired node can still be a legitimate bridge
        // — e.g. a deprecated tool [[link]]ing to its replacement — and excluding it mid-BFS would
        // silently sever that path. Only which nodes are RETURNED is affected here.
        const nodes = allNodes.filter((n) => isVisible(n.entity, input.include_retired));
        const limit = input.limit ?? 100;
        const start = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
        const page = nodes.slice(start, start + limit);
        const next = start + limit < nodes.length ? String(start + limit) : null;
        const asOf = input.as_of ?? (ctx.now ?? Date.now)();
        return {
          vault: v.id,
          as_of: asOf,
          seed_entity_id: seed.id,
          items: page.map((n) => ({
            entity_id: n.entity.id,
            type: n.entity.entity_type,
            name: n.entity.name,
            status: n.entity.status,
            distance: n.distance,
            path: n.path,
            observations: observationsAsOf(ctx.db, n.entity, asOf).map(toObservationOutput),
          })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),
  ];
}
