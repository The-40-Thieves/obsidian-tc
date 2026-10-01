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
import { inWriteTransaction } from "../../db/txn";
import { fingerprintTargets } from "../../elicit-drift";
import {
  enforceMemoryDefense,
  enforceMemoryDefenseOnTransformed,
} from "../../experiential/memory-defense";
import { argsHash } from "../../hash";
import type { ToolDefinition } from "../../mcp/registry";
import {
  deleteEntity,
  deleteRelation,
  findEntity,
  relationsForEntity,
  updateEntity,
} from "../../memory/entities";
import { assertNoteOwnership, entityNotePath, sanitizeSegment } from "../../memory/materialize";
import { enforcePathAcl } from "../../vault/acl-path";
import { hardDelete, noteExists, readNote, trashNote, writeNoteAtomic } from "../../vault/notes-io";
import { resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import {
  assertMemoryPathReadable,
  currentNotePath,
  getReadableEntity,
  type Neighbor,
  planNeighbors,
  readableRelations,
  rematerialize,
  rematerializeNeighbors,
} from "./memory-projection";
import { type M5Deps, memoryDefenseFor, memoryFolderFor } from "./shared";

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
  // GH #994: present only when memoryDefense.mode is "redact" and new_name matched.
  redactions: z.number().int().nonnegative().optional(),
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
        "Rename a memory entity and/or change its lifecycle status (active/retired). At least one of new_name/status is required. This is the reachable path for retiring an entity — get_entity and query_entity_graph filter status:retired out by default. Renaming moves the materialized note (preserving any frontmatter Obsidian or a person added directly to the file) and re-materializes every OTHER materialized entity that has a relation TO this one, so their [[links]] keep resolving under the new name. Does not rewrite free-text mentions of the old name elsewhere in the vault — only entities with a direct graph edge to this one are touched.",
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
        const e = getReadableEntity(deps, ctx, v.id, input.entity_id);
        if (!e) throw err.invalidInput("entity not found", { entity_id: input.entity_id });

        // GH #994: new_name is caller-controlled free text that becomes the entity's persisted
        // identity — the SQLite `name` column, the materialized note's filename AND its H1, and
        // every OTHER materialized entity's [[link]] text once neighbors are re-materialized
        // below. Scanned/enforced BEFORE the uniqueness check or any path is computed from it, so
        // a `block` refusal leaves the entity exactly as it was (mirrors create_entity's own
        // "before anything is persisted" placement).
        const mdConfig = memoryDefenseFor(deps, v.id);
        const nameScan =
          input.new_name !== undefined
            ? enforceMemoryDefense(
                mdConfig,
                { new_name: input.new_name },
                { metrics: deps.metrics },
              )
            : undefined;
        const rawNextName =
          (nameScan ? (nameScan.fields.new_name as string) : input.new_name) ?? e.name;
        // GH #994 review finding 1: `nextName` also becomes the renamed note's PATH segment
        // (entityNotePath -> sanitizeSegment) — a transform that runs AFTER the scan above and
        // can turn a non-matching raw string into a secret-shaped one. Re-scan the sanitized form
        // too (no-op when `new_name` was not provided at all, or when nothing matches either
        // form).
        const pathSegmentScan =
          input.new_name !== undefined
            ? enforceMemoryDefenseOnTransformed(
                mdConfig,
                "new_name",
                rawNextName,
                sanitizeSegment(rawNextName),
                { metrics: deps.metrics },
              )
            : { value: rawNextName, redactions: 0 };
        const nextName = pathSegmentScan.value;
        const renaming = nextName !== e.name;
        const folder = memoryFolderFor(deps, v.id);
        const oldPath = currentNotePath(deps, v.id, e);
        const newPath = entityNotePath(folder, e.entity_type, nextName);
        // As in create_entity: the destination must be readable BEFORE the collision lookup, so
        // "already exists" is only said about an entity the caller could read anyway.
        if (renaming) assertMemoryPathReadable(ctx, v.root, newPath);
        if (renaming && findEntity(ctx.db, v.id, e.entity_type, nextName))
          throw err.invalidInput("entity already exists", { type: e.entity_type, name: nextName });
        // Pre-check the materialization ACL BEFORE mutating SQLite (mirrors create_entity /
        // THE-567) so a denial leaves the entity exactly as it was — no partial rename.
        if (e.materialize === 1) {
          if (renaming) enforcePathAcl(ctx.acl, "delete", oldPath, v.root, ctx.grantedScopes);
          enforcePathAcl(ctx.acl, "write", newPath, v.root, ctx.grantedScopes);
        }

        // Review finding: ownership pre-checks BEFORE any SQLite mutation, so a refusal here is a
        // pure no-op (nothing to roll back), not a partial rename. `oldPath` covers the
        // status-only case too (there `newPath === oldPath`): a foreign note planted at the
        // entity's OWN current path must refuse before the status/name update commits, not leave
        // the row changed with its note write silently failing afterward. `newPath` (renaming
        // only) is what the "seed the new path with the old note's bytes" write below used to
        // skip entirely — it wrote directly, bypassing materializeEntity's ownership check, and
        // could silently overwrite a foreign note sitting at the destination.
        const neighborsToRematerialize: Neighbor[] = [];
        if (e.materialize === 1) {
          assertNoteOwnership(v.root, oldPath, e.id);
          if (renaming) assertNoteOwnership(v.root, newPath, e.id);
          if (renaming) {
            // Every OTHER materialized entity with a relation TO this one will have its own note
            // re-materialized below (so its [[link]] follows the new name) — pre-check ownership
            // of EACH of those notes too, or a foreign note at any one of them would leave this
            // entity's own rename committed with no way to know a neighbor's update silently
            // never happened.
            const incoming = relationsForEntity(ctx.db, e.id).filter((r) => r.direction === "in");
            neighborsToRematerialize.push(...planNeighbors(deps, ctx, v, incoming));
          }
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
        return inWriteTransaction(ctx.db, "memory_rename", () => {
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
              // Already ownership-checked above — this write can only ever land on a free path or
              // this entity's own.
              writeNoteAtomic(resolveVaultPath(v.root, newPath), oldRaw, true);
            }
            vaultPath = rematerialize(deps, ctx, v, updated, now);
            if (renaming) {
              const oldAbs = resolveVaultPath(v.root, oldPath);
              if (noteExists(oldAbs).exists) hardDelete(oldAbs);
            }
          }

          // Keep every OTHER materialized entity's [[link]] to this one pointing at its (possibly
          // new) name — the set pre-checked above.
          const neighborsRematerialized = rematerializeNeighbors(
            deps,
            ctx,
            v,
            neighborsToRematerialize,
            now,
          );

          return {
            entity_id: updated.id,
            type: updated.entity_type,
            name: updated.name,
            status: updated.status,
            vault_path: vaultPath,
            updated_at: updated.updated_at,
            neighbors_rematerialized: neighborsRematerialized,
            ...((nameScan?.redactions ?? 0) + pathSegmentScan.redactions > 0
              ? { redactions: (nameScan?.redactions ?? 0) + pathSegmentScan.redactions }
              : {}),
          };
        });
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
        const src = getReadableEntity(deps, ctx, v.id, input.source_id);
        const tgt = getReadableEntity(deps, ctx, v.id, input.target_id);
        if (!src) throw err.invalidInput("source entity not found", { entity_id: input.source_id });
        if (!tgt) throw err.invalidInput("target entity not found", { entity_id: input.target_id });
        // Mirrors link_entities: only the SOURCE's materialized note is affected (its outgoing
        // [[links]]), so only its ACL is pre-checked.
        const srcPath = currentNotePath(deps, v.id, src);
        if (src.materialize === 1) {
          enforcePathAcl(ctx.acl, "write", srcPath, v.root, ctx.grantedScopes);
          // Review finding: pre-check BEFORE deleteRelation, not after — the relation used to be
          // removed first and only discovered the ownership refusal when rematerialize ran,
          // leaving the edge gone with nothing to restore it.
          assertNoteOwnership(v.root, srcPath, src.id);
        }
        const now = (ctx.now ?? Date.now)();
        return inWriteTransaction(ctx.db, "memory_unlink", () => {
          const { existed } = deleteRelation(ctx.db, src.id, tgt.id, input.relation_type);
          const sourceVaultPath = rematerialize(deps, ctx, v, src, now);
          return {
            source_id: src.id,
            target_id: tgt.id,
            relation_type: input.relation_type,
            removed: existed,
            source_vault_path: sourceVaultPath,
          };
        });
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
      // The entity row (content, updated_at), its relations and its materialized note: an edit, a
      // new relation or a hand-edited note since the request moves it.
      confirmationTargets: (input, { ctx, vaultId, root }) => {
        const e = getReadableEntity(deps, ctx, vaultId, input.entity_id);
        if (!e) return argsHash("state", "absent");
        const note =
          root && e.materialize === 1
            ? fingerprintTargets(root, [currentNotePath(deps, vaultId, e)])
            : null;
        return argsHash("state", { e, note, relations: readableRelations(deps, ctx, e).visible });
      },
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const e = getReadableEntity(deps, ctx, v.id, input.entity_id);
        if (!e) throw err.invalidInput("entity not found", { entity_id: input.entity_id });

        // Only edges to entities the caller can read are counted, listed or fingerprinted — the
        // same set get_entity shows. An entity whose only edges are hidden ones deletes exactly
        // like one with none (refusing would reveal them); deleting removes those edges too, as
        // part of removing the entity, without a word about them.
        const { visible, hidden } = readableRelations(deps, ctx, e);
        if (visible.length > 0 && !input.cascade)
          throw err.invalidInput("entity has relations; pass cascade to delete them too", {
            entity_id: e.id,
            relation_count: visible.length,
            relations: visible.map((r) => ({
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
        const incoming = [...visible, ...hidden].filter((r) => r.direction === "in");

        // Review finding: ownership pre-checks BEFORE any SQLite mutation — the entity's own note
        // (about to be trashed/permanently deleted below) AND every neighbor's note cascade will
        // re-materialize once this entity's relations are gone, since deleteEntity + the trash/
        // hardDelete used to run unconditionally, discovering a foreign note only via rematerialize
        // AFTER the row and its relations were already gone with nothing left to restore them.
        if (notePath) assertNoteOwnership(v.root, notePath, e.id);
        const neighborsToRematerialize = planNeighbors(deps, ctx, v, incoming);

        const now = (ctx.now ?? Date.now)();
        const { relationsDeleted } = inWriteTransaction(ctx.db, "memory_delete", () => {
          const { deleted, relationsDeleted: deletedCount } = deleteEntity(ctx.db, e.id);
          if (!deleted) throw err.invalidInput("entity not found", { entity_id: input.entity_id });
          rematerializeNeighbors(deps, ctx, v, neighborsToRematerialize, now);
          return { relationsDeleted: deletedCount };
        });

        // Already ownership-checked above — this can only ever touch this entity's own note.
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
          relations_deleted: relationsDeleted - hidden.length,
          vault_path: notePath,
          permanent: input.permanent,
          trashed_to: trashedTo,
        };
      },
    }),
  ];
}
