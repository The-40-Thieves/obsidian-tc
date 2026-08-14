// THE-833: the materialization helpers shared between memory-tools.ts (create/get/observe/link/
// query) and memory-lifecycle-tools.ts (rename/unlink/delete). Lifted out of memory-tools.ts so
// the two tool files can both use them without importing from each other — memory-tools.ts was
// already close to biome's 700-line ceiling before this ticket's three new tools, which would have
// pushed it over; a straight split needs a shared home for the helpers both files call, or one
// file ends up importing tool-registration code from the other for no reason but a function body.
import type { CallerContext } from "../../mcp/registry";
import {
  type EntityRow,
  parseObservations,
  relationsForEntity,
  setEntityVaultPath,
} from "../../memory/entities";
import { entityNotePath, materializeEntity, type RelationLink } from "../../memory/materialize";
import type { ResolvedVault } from "../../vault/registry";
import { type M5Deps, memoryFolderFor } from "./shared";

/** Outgoing relations of an entity as [[link]] targets, for materialization. */
export function outgoingLinks(ctx: CallerContext, id: string): RelationLink[] {
  return relationsForEntity(ctx.db, id)
    .filter((r) => r.direction === "out")
    .map((r) => ({ relationType: r.relation_type, targetName: r.other_name }));
}

/** The FILESYSTEM half of a rematerialize: regenerate an entity's .md projection from an
 *  EXPLICIT observation list, so a caller can render the state it is *about* to commit rather
 *  than the state already in SQLite (THE-572). Returns the written path, or null when the entity
 *  is not materialized. Writes no DB row — the caller persists `vault_path` itself, which is what
 *  lets that write join the caller's transaction.
 *
 *  Idempotent by construction: materializeEntity renders the whole note and writes it with
 *  writeNoteAtomic, so running it twice with the same inputs produces identical bytes. */
export function materializeProjection(
  deps: M5Deps,
  ctx: CallerContext,
  v: ResolvedVault,
  e: EntityRow,
  observations: readonly string[],
): string | null {
  if (e.materialize !== 1) return null;
  return materializeEntity({
    root: v.root,
    acl: ctx.acl,
    folder: memoryFolderFor(deps, v.id),
    id: e.id,
    entityType: e.entity_type,
    name: e.name,
    status: e.status,
    observations: [...observations],
    relations: outgoingLinks(ctx, e.id),
    grantedScopes: ctx.grantedScopes,
  }).vaultPath;
}

/** Regenerate an entity's .md projection from current SQLite state (no-op when the
 *  entity is not materialized). Returns the materialized path or the stored one. */
export function rematerialize(
  deps: M5Deps,
  ctx: CallerContext,
  v: ResolvedVault,
  e: EntityRow,
  now: number,
): string | null {
  if (e.materialize !== 1) return e.vault_path;
  const vaultPath = materializeProjection(
    deps,
    ctx,
    v,
    e,
    parseObservations(e.observations),
  ) as string;
  setEntityVaultPath(ctx.db, e.id, vaultPath, now);
  return vaultPath;
}

/** THE-833: the note path an entity is (or would be) materialized at, from its current row —
 *  shared by rename_entity (old-path lookup before the row is renamed) and delete_entity (the
 *  path to trash). */
export function currentNotePath(deps: M5Deps, vaultId: string, e: EntityRow): string {
  return entityNotePath(memoryFolderFor(deps, vaultId), e.entity_type, e.name);
}
