// Domain 22 — Memory entities + [[link]] graph (G2.1). Five tools over the SQLite
// memory_entities + memory_relations tables: create_entity, get_entity,
// add_observation, link_entities, query_entity_graph. SQLite is the SOURCE OF TRUTH;
// each materialized entity also gets a regenerable .md projection so its [[links]]
// resolve in Obsidian's graph. Reads take read:memory, mutations take write:memory
// (write family — readOnly kill-switch applies, no execute HITL floor; spec hitl:never).
// Materialization funnels through resolveVaultPath + enforcePathAcl; the write ACL is
// pre-checked before the SQLite insert so an ACL denial leaves no orphan row.
import { err, Pagination, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import {
  appendObservation,
  bfsGraph,
  type EntityRow,
  findEntitiesByName,
  findEntity,
  getEntityById,
  insertEntity,
  insertRelation,
  isUniqueViolation,
  parseObservations,
  relationsForEntity,
  setEntityVaultPath,
} from "../../memory/entities";
import { entityNotePath, materializeEntity, type RelationLink } from "../../memory/materialize";
import { enforcePathAcl } from "../../vault/acl-path";
import type { ResolvedVault } from "../../vault/registry";
import { defineTool } from "../m1/define";
import { type M5Deps, memoryFolderFor } from "./shared";

/** Outgoing relations of an entity as [[link]] targets, for materialization. */
function outgoingLinks(ctx: CallerContext, id: string): RelationLink[] {
  return relationsForEntity(ctx.db, id)
    .filter((r) => r.direction === "out")
    .map((r) => ({ relationType: r.relation_type, targetName: r.other_name }));
}

/** Regenerate an entity's .md projection from current SQLite state (no-op when the
 *  entity is not materialized). Returns the materialized path or the stored one. */
function rematerialize(
  deps: M5Deps,
  ctx: CallerContext,
  v: ResolvedVault,
  e: EntityRow,
  now: number,
): string | null {
  if (e.materialize !== 1) return e.vault_path;
  const res = materializeEntity({
    root: v.root,
    acl: ctx.acl,
    folder: memoryFolderFor(deps, v.id),
    id: e.id,
    entityType: e.entity_type,
    name: e.name,
    observations: parseObservations(e.observations),
    relations: outgoingLinks(ctx, e.id),
  });
  setEntityVaultPath(ctx.db, e.id, res.vaultPath, now);
  return res.vaultPath;
}

export function buildMemoryTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "create_entity",
      description:
        "Create a typed memory entity (optionally materialized as a vault .md note). SQLite is the source of truth.",
      inputSchema: z
        .object({
          vault: VaultId,
          type: z.string().min(1),
          name: z.string().min(1),
          observations: z.array(z.string()).optional(),
          materialize: z.boolean().default(true),
        })
        .strict(),
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (findEntity(ctx.db, v.id, input.type, input.name))
          throw err.invalidInput("entity already exists", { type: input.type, name: input.name });
        const now = (ctx.now ?? Date.now)();
        const folder = memoryFolderFor(deps, v.id);
        // Pre-check the materialization ACL so a denial leaves no orphan SQLite row.
        if (input.materialize)
          enforcePathAcl(ctx.acl, "write", entityNotePath(folder, input.type, input.name));
        let e: EntityRow;
        try {
          e = insertEntity(ctx.db, {
            vaultId: v.id,
            entityType: input.type,
            name: input.name,
            observations: input.observations,
            materialize: input.materialize,
            now,
          });
        } catch (caught) {
          // The UNIQUE natural-key index closes the findEntity read-then-insert race (F4).
          if (isUniqueViolation(caught))
            throw err.invalidInput("entity already exists", { type: input.type, name: input.name });
          throw caught;
        }
        const vaultPath = input.materialize ? rematerialize(deps, ctx, v, e, now) : null;
        return {
          entity_id: e.id,
          type: e.entity_type,
          name: e.name,
          materialized: input.materialize,
          vault_path: vaultPath,
          created_at: e.created_at,
        };
      },
    }),

    defineTool({
      name: "get_entity",
      description:
        "Read a memory entity by id, by type+name, or by unique name, with its observations and relations.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
        })
        .strict(),
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
          const hits = findEntitiesByName(ctx.db, v.id, input.name);
          if (hits.length > 1)
            throw err.invalidInput("entity name is ambiguous; provide type", {
              name: input.name,
              candidates: hits.map((h) => ({ entity_id: h.id, type: h.entity_type })),
            });
          e = hits[0];
        } else {
          throw err.invalidInput("provide entity_id, or type+name, or name");
        }
        if (!e) throw err.invalidInput("entity not found", { vault: v.id });
        const relations = relationsForEntity(ctx.db, e.id).map((r) => ({
          target_id: r.other_id,
          target_name: r.other_name,
          target_type: r.other_type,
          relation_type: r.relation_type,
          direction: r.direction,
        }));
        return {
          entity_id: e.id,
          type: e.entity_type,
          name: e.name,
          observations: parseObservations(e.observations),
          relations,
          vault_path: e.vault_path,
          created_at: e.created_at,
          updated_at: e.updated_at,
        };
      },
    }),

    defineTool({
      name: "add_observation",
      description:
        "Append a fact to a memory entity (re-materializing its note when materialized).",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().min(1),
          observation: z.string().min(1),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const existing = getEntityById(ctx.db, input.entity_id);
        if (!existing || existing.vault_id !== v.id)
          throw err.invalidInput("entity not found", { entity_id: input.entity_id });
        const now = (ctx.now ?? Date.now)();
        const r = appendObservation(ctx.db, existing.id, input.observation, now);
        if (!r) throw err.invalidInput("entity not found", { entity_id: input.entity_id });
        const refreshed = getEntityById(ctx.db, existing.id) as EntityRow;
        const vaultPath = rematerialize(deps, ctx, v, refreshed, now);
        return {
          entity_id: refreshed.id,
          observation_count: r.observationCount,
          updated_at: r.updatedAt,
          vault_path: vaultPath,
        };
      },
    }),

    defineTool({
      name: "link_entities",
      description:
        "Create a typed relation between two memory entities (idempotent; re-materializes the source's [[links]]).",
      inputSchema: z
        .object({
          vault: VaultId,
          source_id: z.string().min(1),
          target_id: z.string().min(1),
          relation_type: z.string().min(1),
        })
        .strict(),
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const src = getEntityById(ctx.db, input.source_id);
        const tgt = getEntityById(ctx.db, input.target_id);
        if (!src || src.vault_id !== v.id)
          throw err.invalidInput("source entity not found", { entity_id: input.source_id });
        if (!tgt || tgt.vault_id !== v.id)
          throw err.invalidInput("target entity not found", { entity_id: input.target_id });
        const now = (ctx.now ?? Date.now)();
        const { existedAlready } = insertRelation(ctx.db, src.id, tgt.id, input.relation_type, now);
        const sourceVaultPath = rematerialize(deps, ctx, v, src, now);
        return {
          source_id: src.id,
          target_id: tgt.id,
          relation_type: input.relation_type,
          created_at: now,
          existed_already: existedAlready,
          source_vault_path: sourceVaultPath,
        };
      },
    }),

    defineTool({
      name: "query_entity_graph",
      description:
        "Traverse the memory graph from a seed entity (BFS, depth-limited, type/direction filtered).",
      inputSchema: z
        .object({
          vault: VaultId,
          seed_entity_id: z.string().min(1),
          depth: z.number().int().positive().max(5).optional(),
          relation_types: z.array(z.string()).optional(),
          entity_types: z.array(z.string()).optional(),
          direction: z.enum(["out", "in", "both"]).default("both"),
        })
        .merge(Pagination)
        .strict(),
      requiredScopes: ["read:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const seed = getEntityById(ctx.db, input.seed_entity_id);
        if (!seed || seed.vault_id !== v.id)
          throw err.invalidInput("seed entity not found", { seed_entity_id: input.seed_entity_id });
        const nodes = bfsGraph(ctx.db, seed.id, {
          depth: input.depth,
          direction: input.direction,
          relationTypes: input.relation_types,
          entityTypes: input.entity_types,
        });
        const limit = input.limit ?? 100;
        const start = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
        const page = nodes.slice(start, start + limit);
        const next = start + limit < nodes.length ? String(start + limit) : null;
        return {
          vault: v.id,
          seed_entity_id: seed.id,
          items: page.map((n) => ({
            entity_id: n.entity.id,
            type: n.entity.entity_type,
            name: n.entity.name,
            distance: n.distance,
            path: n.path,
          })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),
  ];
}
