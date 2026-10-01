// THE-833: the materialization helpers shared between memory-tools.ts (create/get/observe/link/
// query) and memory-lifecycle-tools.ts (rename/unlink/delete). Lifted out of memory-tools.ts so
// the two tool files can both use them without importing from each other — memory-tools.ts was
// already close to biome's 700-line ceiling before this ticket's three new tools, which would have
// pushed it over; a straight split needs a shared home for the helpers both files call, or one
// file ends up importing tool-registration code from the other for no reason but a function body.
import type { CallerContext } from "../../mcp/registry";
import {
  type EntityRow,
  getEntityById,
  type ObservationView,
  observationViews,
  relationsForEntity,
  setEntityVaultPath,
} from "../../memory/entities";
import { entityNotePath, materializeEntity, type RelationLink } from "../../memory/materialize";
import { readableRel, readEnumerationUnrestricted } from "../../vault/acl-read-filter";
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
  observations: readonly ObservationView[],
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
  const vaultPath = materializeProjection(deps, ctx, v, e, observationViews(ctx.db, e)) as string;
  setEntityVaultPath(ctx.db, e.id, vaultPath, now);
  return vaultPath;
}

/** THE-833: the note path an entity is (or would be) materialized at, from its current row —
 *  shared by rename_entity (old-path lookup before the row is renamed) and delete_entity (the
 *  path to trash). */
export function currentNotePath(deps: M5Deps, vaultId: string, e: EntityRow): string {
  return entityNotePath(memoryFolderFor(deps, vaultId), e.entity_type, e.name);
}

/** What the read gate needs of a call context (also what `confirmationTargets` receives). */
type ReadCtx = Pick<CallerContext, "acl" | "db" | "grantedScopes">;

/** May this caller read this entity? An entity's projection note (<memoryFolder>/<type>/<name>.md)
 *  renders the same observations and [[links]] get_entity returns, so the answer is exactly whether
 *  read_note could read that note: `readableRel` on the CURRENT path (computed, so a materialize:
 *  false entity and a renamed one with a stale `vault_path` are gated too), and also on a differing
 *  stored `vault_path` (an old location may still hold the content). Unrestricted callers (no
 *  readPaths, no strictReadDefault, no rule-scope they lack) short-circuit. A path that cannot be
 *  computed FAILS CLOSED. `ctx.acl` is the requested vault's ACL: dispatch's applyVaultAcl swaps
 *  it in for every tool whose input names a `vault`. */
export function memoryReadable(deps: M5Deps, ctx: ReadCtx, e: EntityRow): boolean {
  if (readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes)) return true;
  try {
    const paths = [currentNotePath(deps, e.vault_id, e)];
    if (e.vault_path !== null && e.vault_path !== paths[0]) paths.push(e.vault_path);
    return paths.every((rel) => readableRel(ctx.acl, rel, ctx.grantedScopes));
  } catch {
    return false;
  }
}

/** Look an entity up by id in `vaultId`, treating one the caller cannot read exactly like one that
 *  does not exist (denied == missing), so no tool's not-found error can serve as an existence
 *  oracle. The ONE entity-by-id lookup the memory tools use. */
export function getReadableEntity(
  deps: M5Deps,
  ctx: ReadCtx,
  vaultId: string,
  id: string,
): EntityRow | undefined {
  const found = getEntityById(ctx.db, id);
  return found && found.vault_id === vaultId && memoryReadable(deps, ctx, found)
    ? found
    : undefined;
}
