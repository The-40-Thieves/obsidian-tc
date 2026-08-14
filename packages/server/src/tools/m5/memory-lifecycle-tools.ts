// THE-833 — the memory-entity lifecycle's correction/removal half: rename_entity, unlink_entities,
// delete_entity. Split out of memory-tools.ts (which already carried create/get/observe/link/query
// close to biome's 700-line file ceiling) rather than grown into it; both files share their
// materialization helpers via memory-projection.ts so neither imports the other.
//
// RETIRING IS REACHABLE THROUGH rename_entity, not a fifth tool and not a param bolted onto an
// unrelated existing one. create_entity/add_observation/link_entities each own a single, narrow
// concern (make a node, add a fact, add an edge); status is neither of those — it is a correction
// to the entity's own identity/lifecycle, the same axis a rename is on. Folding it into
// rename_entity's shape (both `new_name` and `status` optional, at least one required) means one
// tool answers "I got this entity wrong" instead of splitting that into "wrong name" vs "wrong
// lifecycle state" tools that would frequently be called together anyway. The alternative — a
// `status` param on `add_observation` or `link_entities` — was rejected: neither tool's name or
// existing shape has anything to do with retiring a node, and overloading them would make their
// own single concern harder to reason about for no reduction in tool count.
//
// delete_entity is deliberately the LAST resort (destructive: true, dependency-aware like
// `forget`): retiring via rename_entity's status param is the primary path the ticket asks for,
// because it preserves the append-only philosophy the external reporter explicitly wants kept —
// nothing already linked ever silently disappears out from under a caller that queried the graph a
// moment before. delete_entity exists for "created it by accident", not for ordinary lifecycle
// churn.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import {
  deleteEntity,
  deleteRelation,
  findEntity,
  getEntityById,
  relationsForEntity,
  updateEntity,
} from "../../memory/entities";
import { entityNotePath } from "../../memory/materialize";
import { enforcePathAcl } from "../../vault/acl-path";
import { hardDelete, noteExists, readNote, trashNote, writeNoteAtomic } from "../../vault/notes-io";
import { resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { currentNotePath, rematerialize } from "./memory-projection";
import { type M5Deps, memoryFolderFor } from "./shared";

const EntityStatusSchema = z.enum(["active", "retired"]);

const RenameEntityOutput = z.object({
  entity_id: z.string(),
  type: z.string(),
  name: z.string(),
  status: EntityStatusSchema,
  vault_path: z.string().nullable(),
  updated_at: z.number(),
  // How many OTHER materialized entities (ones with a live relation TO this one) had their note
  // re-materialized so their [[link]] text follows a rename. 0 when the name didn't change, or
  // when none of the incoming-relation sources are materialized.
  neighbors_rematerialized: z.number(),
});

const UnlinkEntitiesOutput = z.object({
  source_id: z.string(),
  target_id: z.string(),
  relation_type: z.string(),
  removed: z.boolean(),
  source_vault_path: z.string().nullable(),
});

const DeleteEntityOutput = z.object({
  entity_id: z.string(),
  deleted: z.boolean(),
  relations_deleted: z.number(),
  vault_path: z.string().nullable(),
  permanent: z.boolean(),
  trashed_to: z.string().nullable(),
});

export function buildMemoryLifecycleTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "rename_entity",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Rename a memory entity and/or change its lifecycle status (active/retired). At least one of new_name/status is required. THE-833: this is the reachable path for retiring an entity — get_entity and query_entity_graph filter status:retired out by default. Renaming moves the materialized note (preserving any frontmatter Obsidian or a person added directly to the file) and re-materializes every OTHER materialized entity that has a relation TO this one, so their [[links]] keep resolving under the new name. Does not rewrite free-text mentions of the old name elsewhere in the vault — only entities with a direct graph edge to this one are touched.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().min(1),
          new_name: z.string().min(1).optional(),
          status: EntityStatusSchema.optional(),
        })
        .strict(),
      outputSchema: RenameEntityOutput,
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        if (input.new_name === undefined && input.status === undefined)
          throw err.invalidInput("provide new_name or status");
        const v = deps.vaultRegistry.resolve(input.vault);
        const e = getEntityById(ctx.db, input.entity_id);
        if (!e || e.vault_id !== v.id)
          throw err.invalidInput("entity not found", { entity_id: input.entity_id });

        const nextName = input.new_name ?? e.name;
        const renaming = nextName !== e.name;
        if (renaming && findEntity(ctx.db, v.id, e.entity_type, nextName))
          throw err.invalidInput("entity already exists", { type: e.entity_type, name: nextName });

        const folder = memoryFolderFor(deps, v.id);
        const oldPath = currentNotePath(deps, v.id, e);
        const newPath = entityNotePath(folder, e.entity_type, nextName);
        // Pre-check the materialization ACL BEFORE mutating SQLite (mirrors create_entity /
        // THE-567) so a denial leaves the entity exactly as it was — no partial rename.
        if (e.materialize === 1) {
          if (renaming) enforcePathAcl(ctx.acl, "delete", oldPath, v.root, ctx.grantedScopes);
          enforcePathAcl(ctx.acl, "write", newPath, v.root, ctx.grantedScopes);
        }

        // Capture the OLD note's raw bytes BEFORE anything moves, so the rename can carry its
        // preserved (non-owned) frontmatter forward. materializeEntity only preserves frontmatter
        // it finds already sitting AT THE TARGET path — on a rename that path doesn't exist yet,
        // so without this the note's aliases/cssclasses/etc. would be silently dropped.
        let oldRaw: string | null = null;
        if (e.materialize === 1 && renaming) {
          const oldAbs = resolveVaultPath(v.root, oldPath);
          const ex = noteExists(oldAbs);
          if (ex.exists && ex.type === "file") oldRaw = readNote(oldAbs).raw;
        }

        const now = (ctx.now ?? Date.now)();
        const updated = updateEntity(
          ctx.db,
          e.id,
          {
            name: renaming ? nextName : undefined,
            status:
              input.status !== undefined && input.status !== e.status ? input.status : undefined,
          },
          now,
        );
        if (!updated) throw err.invalidInput("entity not found", { entity_id: input.entity_id });

        let vaultPath: string | null = e.vault_path;
        if (updated.materialize === 1) {
          if (renaming && oldRaw !== null) {
            // Seed the new path with the old note's bytes so materializeEntity's own
            // "does a note already exist here" check fires at the NEW path and preserves it.
            writeNoteAtomic(resolveVaultPath(v.root, newPath), oldRaw, true);
          }
          vaultPath = rematerialize(deps, ctx, v, updated, now);
          if (renaming) {
            const oldAbs = resolveVaultPath(v.root, oldPath);
            if (noteExists(oldAbs).exists) hardDelete(oldAbs);
          }
        }

        // Keep every OTHER materialized entity's [[link]] to this one pointing at its (possibly
        // new) name. relationsForEntity's "in" edges are entities with a relation TO this one;
        // rematerializing each regenerates its Related section from a LIVE join against
        // memory_entities/memory_relations, which already reflects the renamed row.
        let neighborsRematerialized = 0;
        if (renaming) {
          const incoming = relationsForEntity(ctx.db, updated.id).filter(
            (r) => r.direction === "in",
          );
          const seen = new Set<string>();
          for (const r of incoming) {
            if (seen.has(r.other_id)) continue;
            seen.add(r.other_id);
            const src = getEntityById(ctx.db, r.other_id);
            if (src && src.materialize === 1) {
              rematerialize(deps, ctx, v, src, now);
              neighborsRematerialized++;
            }
          }
        }

        return {
          entity_id: updated.id,
          type: updated.entity_type,
          name: updated.name,
          status: updated.status,
          vault_path: vaultPath,
          updated_at: updated.updated_at,
          neighbors_rematerialized: neighborsRematerialized,
        };
      },
    }),

    defineTool({
      name: "unlink_entities",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Remove a typed relation between two memory entities — the inverse of link_entities. Removes only the named (source, target, relation_type) edge and leaves every other relation intact; re-materializes the source's [[links]]. A no-op (removed: false) when the relation didn't exist.",
      inputSchema: z
        .object({
          vault: VaultId,
          source_id: z.string().min(1),
          target_id: z.string().min(1),
          relation_type: z.string().min(1),
        })
        .strict(),
      outputSchema: UnlinkEntitiesOutput,
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const src = getEntityById(ctx.db, input.source_id);
        const tgt = getEntityById(ctx.db, input.target_id);
        if (!src || src.vault_id !== v.id)
          throw err.invalidInput("source entity not found", { entity_id: input.source_id });
        if (!tgt || tgt.vault_id !== v.id)
          throw err.invalidInput("target entity not found", { entity_id: input.target_id });
        // Mirrors link_entities: only the SOURCE's materialized note is affected (its outgoing
        // [[links]]), so only its ACL is pre-checked.
        if (src.materialize === 1)
          enforcePathAcl(
            ctx.acl,
            "write",
            currentNotePath(deps, v.id, src),
            v.root,
            ctx.grantedScopes,
          );
        const { existed } = deleteRelation(ctx.db, src.id, tgt.id, input.relation_type);
        const now = (ctx.now ?? Date.now)();
        const sourceVaultPath = rematerialize(deps, ctx, v, src, now);
        return {
          source_id: src.id,
          target_id: tgt.id,
          relation_type: input.relation_type,
          removed: existed,
          source_vault_path: sourceVaultPath,
        };
      },
    }),

    defineTool({
      name: "delete_entity",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Delete a memory entity outright — the escape hatch for 'created it by accident', NOT the primary retirement path (use rename_entity's status param to retire instead; that stays reversible, this doesn't). Destructive; requires confirmation. Dependency-aware like `forget`: refuses when the entity has any relation, incoming or outgoing, unless cascade is set — in which case those relations are removed too and every OTHER materialized entity that referenced this one has its note re-materialized so its [[links]] stop dangling. The entity's own note is trashed (recoverable) unless permanent is set.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().min(1),
          // THE-833 dependency rule: an entity with relations is refused by default (mirrors
          // `forget`'s "report before you touch derived state" posture) rather than silently
          // cascaded — a relation is another entity's data too, not solely this one's.
          cascade: z.boolean().default(false),
          permanent: z.boolean().default(false),
        })
        .strict(),
      outputSchema: DeleteEntityOutput,
      requiredScopes: ["delete:memory"],
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const e = getEntityById(ctx.db, input.entity_id);
        if (!e || e.vault_id !== v.id)
          throw err.invalidInput("entity not found", { entity_id: input.entity_id });

        const relations = relationsForEntity(ctx.db, e.id);
        if (relations.length > 0 && !input.cascade)
          throw err.invalidInput("entity has relations; pass cascade to delete them too", {
            entity_id: e.id,
            relation_count: relations.length,
            relations: relations.map((r) => ({
              relation_type: r.relation_type,
              direction: r.direction,
              other_id: r.other_id,
              other_name: r.other_name,
            })),
          });

        const notePath = e.materialize === 1 ? currentNotePath(deps, v.id, e) : null;
        // Pre-check BEFORE the SQLite delete (mirrors create_entity/rename_entity/THE-567): a
        // denial must leave the entity exactly as it was.
        if (notePath) enforcePathAcl(ctx.acl, "delete", notePath, v.root, ctx.grantedScopes);

        // Capture which OTHER entities point AT this one before deleteEntity removes those
        // relation rows — there is nothing left to query afterward.
        const incomingNeighborIds = [
          ...new Set(relations.filter((r) => r.direction === "in").map((r) => r.other_id)),
        ];

        const { deleted, relationsDeleted } = deleteEntity(ctx.db, e.id);
        if (!deleted) throw err.invalidInput("entity not found", { entity_id: input.entity_id });

        const now = (ctx.now ?? Date.now)();
        for (const id of incomingNeighborIds) {
          const src = getEntityById(ctx.db, id);
          if (src && src.materialize === 1) rematerialize(deps, ctx, v, src, now);
        }

        let trashedTo: string | null = null;
        if (notePath) {
          const abs = resolveVaultPath(v.root, notePath);
          if (noteExists(abs).exists) {
            if (input.permanent) hardDelete(abs);
            else trashedTo = trashNote(v.root, notePath);
          }
        }

        return {
          entity_id: e.id,
          deleted: true,
          relations_deleted: relationsDeleted,
          vault_path: notePath,
          permanent: input.permanent,
          trashed_to: trashedTo,
        };
      },
    }),
  ];
}
