// THE-833: the materialization helpers shared between memory-tools.ts (create/get/observe/link/
// query) and memory-lifecycle-tools.ts (rename/unlink/delete). Lifted out of memory-tools.ts so
// the two tool files can both use them without importing from each other — memory-tools.ts was
// already close to biome's 700-line ceiling before this ticket's three new tools, which would have
// pushed it over; a straight split needs a shared home for the helpers both files call, or one
// file ends up importing tool-registration code from the other for no reason but a function body.
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { redactSecrets } from "../../experiential/redact";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import {
  type EntityRow,
  getEntityById,
  observationViews,
  type RelationEdge,
  type RenderableObservation,
  relationsForEntity,
  setEntityVaultPath,
} from "../../memory/entities";
import {
  assertNoteOwnership,
  entityNotePath,
  materializeEntity,
  type RelationLink,
} from "../../memory/materialize";
import { callerCanReadVaultPath, enforcePathAcl } from "../../vault/acl-path";
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
  observations: readonly RenderableObservation[],
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
 *  read_note could read that note (callerCanReadVaultPath on the entity's vault root: hard-denied
 *  roots, readPaths, rule-scopes, symlink and hard-link resolution) on the CURRENT path (computed,
 *  so a materialize:false entity and a renamed one with a stale `vault_path` are gated too), and
 *  also on a differing stored `vault_path` (an old location may still hold the content). There is
 *  no "unrestricted caller" shortcut. A path or vault that cannot be resolved FAILS CLOSED.
 *  `ctx.acl` is the requested vault's ACL: dispatch's applyVaultAcl swaps it in for every tool whose
 *  input names a `vault`. */
export function memoryReadable(deps: M5Deps, ctx: ReadCtx, e: EntityRow): boolean {
  try {
    const root = deps.vaultRegistry.resolve(e.vault_id).root;
    const paths = [currentNotePath(deps, e.vault_id, e)];
    if (e.vault_path !== null && e.vault_path !== paths[0]) paths.push(e.vault_path);
    return paths.every((rel) => callerCanReadVaultPath(ctx.acl, ctx.grantedScopes, root, rel));
  } catch {
    return false;
  }
}

/** Refuse (acl_denied) a note path the caller could not read. create_entity/rename_entity run it
 *  on the path they are ABOUT to claim BEFORE any collision lookup, so "that name is taken" is
 *  only ever said to a caller who could read the entity holding it. The error is a function of the
 *  caller-supplied path alone, never of what is stored. */
export function assertMemoryPathReadable(ctx: ReadCtx, root: string, rel: string): void {
  if (!callerCanReadVaultPath(ctx.acl, ctx.grantedScopes, root, rel))
    throw err.aclDenied("path is outside the read whitelist", {
      path: redactSecrets(rel).text,
      op: "read",
    });
}

/** Refuse (acl_denied) a projection path the caller may not `op` (write by default, delete for the
 *  old path of a rename and for delete_entity). An entity's projection path is its ACL identity
 *  whether or not the .md note is written: `materialize: false` only skips the file, while the
 *  SQLite row is created, extended, linked, renamed or removed all the same. So every memory write
 *  tool runs this on the computed path in BOTH modes, BEFORE any lookup, so the denial is a
 *  function of the caller-supplied path alone (no existence oracle). */
export function assertMemoryPathWritable(
  ctx: Pick<CallerContext, "acl" | "grantedScopes">,
  root: string,
  rel: string,
  op: "write" | "delete" = "write",
): void {
  enforcePathAcl(ctx.acl, op, rel, root, ctx.grantedScopes);
}

/** The relations of `e` whose far end the caller can read: exactly what get_entity shows. Every
 *  count, list and fingerprint a lifecycle tool derives from an entity's relations must come from
 *  this, never from raw `relationsForEntity` (which also holds the edges to hidden entities). */
export function readableRelations(
  deps: M5Deps,
  ctx: ReadCtx,
  e: EntityRow,
): { visible: RelationEdge[]; hidden: RelationEdge[] } {
  const visible: RelationEdge[] = [];
  const hidden: RelationEdge[] = [];
  for (const r of relationsForEntity(ctx.db, e.id))
    (getReadableEntity(deps, ctx, e.vault_id, r.other_id) ? visible : hidden).push(r);
  return { visible, hidden };
}

/** An ownership refusal (`note_exists`) names the entity that owns the note in the way. When that
 *  entity is one the caller cannot read it must not: it becomes a bare acl_denied, no path, no id.
 *  Applied to every memory tool's handler (tools/m5/index.ts). */
export function scrubOwnerDisclosure(deps: M5Deps, tool: ToolDefinition): ToolDefinition {
  const inner = tool.handler;
  return {
    ...tool,
    handler: (input, ctx) => {
      try {
        return inner(input, ctx);
      } catch (caught) {
        const owner =
          caught instanceof ObsidianTcError && caught.code === "note_exists"
            ? (caught.details as { existing_owner_id?: unknown } | undefined)?.existing_owner_id
            : undefined;
        const row = typeof owner === "string" ? getEntityById(ctx.db, owner) : undefined;
        if (row && !memoryReadable(deps, ctx, row))
          throw err.aclDenied("path is outside the read whitelist", { op: "read" });
        throw caught;
      }
    },
  };
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

/** A materialized entity whose note a rename/delete re-materializes so its [[links]] follow.
 *  `visible` false: the caller cannot read it, so it is handled quietly (see planNeighbors). */
export interface Neighbor {
  id: string;
  visible: boolean;
}

/** Plan which OTHER entities' notes a rename/cascade delete re-materializes. A neighbour the
 *  caller can read is pre-checked loudly (an ACL or ownership refusal about an entity it may read
 *  is fine to report, before any SQLite change). A neighbour it CANNOT read is never allowed to
 *  speak: its note is re-materialized only when that is already permitted and clean, and is
 *  otherwise left as it was (stale until its next write, since SQLite stays the source of truth) —
 *  an error, a path or a count here would reveal the hidden entity and its edge. */
export function planNeighbors(
  deps: M5Deps,
  ctx: CallerContext,
  v: ResolvedVault,
  edges: readonly RelationEdge[],
): Neighbor[] {
  const out: Neighbor[] = [];
  const seen = new Set<string>();
  for (const r of edges) {
    if (seen.has(r.other_id)) continue;
    seen.add(r.other_id);
    const src = getEntityById(ctx.db, r.other_id);
    if (src?.materialize !== 1) continue;
    const srcPath = currentNotePath(deps, v.id, src);
    if (memoryReadable(deps, ctx, src)) {
      assertNoteOwnership(v.root, srcPath, src.id);
      out.push({ id: src.id, visible: true });
      continue;
    }
    try {
      enforcePathAcl(ctx.acl, "write", srcPath, v.root, ctx.grantedScopes);
      assertNoteOwnership(v.root, srcPath, src.id);
      out.push({ id: src.id, visible: false });
    } catch {
      /* skipped quietly: see above */
    }
  }
  return out;
}

/** Re-materialize the planned neighbours; returns how many READABLE ones were (hidden ones are
 *  best effort and never counted or reported). */
export function rematerializeNeighbors(
  deps: M5Deps,
  ctx: CallerContext,
  v: ResolvedVault,
  planned: readonly Neighbor[],
  now: number,
): number {
  let count = 0;
  for (const n of planned) {
    const src = getEntityById(ctx.db, n.id);
    if (src?.materialize !== 1) continue;
    if (n.visible) {
      rematerialize(deps, ctx, v, src, now);
      count++;
    } else {
      try {
        rematerialize(deps, ctx, v, src, now);
      } catch {
        /* never surfaced: see planNeighbors */
      }
    }
  }
  return count;
}
