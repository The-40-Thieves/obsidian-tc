// Tag usage counts over the notes the caller may read. One implementation for list_tags and
// suggest_tags, so both see exactly the same ACL-filtered view of the vault's tag vocabulary.
import type { CallerContext } from "../../mcp/registry";
import { readableRel } from "../../vault/acl-read-filter";
import { readNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { noteTags } from "../../vault/tags";

export interface TagCounts {
  notes_scanned: number;
  counts: Map<string, number>;
}

/**
 * THE-291 (3B): aggregate from the notes table when the metadata index is ready — no per-query
 * full-vault disk scan. ACL + folder filtering stay query-time; the cap applies in ORDER BY path
 * order (the disk path used walk order — documented drift).
 */
export function collectTagCounts(
  ready: boolean,
  ctx: CallerContext,
  vault: { id: string; root: string },
  folder: string | undefined,
  maxNotes: number,
): TagCounts {
  const sub = folder ? normalizeVaultPath(folder) : undefined;
  const counts = new Map<string, number>();
  let scanned = 0;
  if (ready) {
    const rows = ctx.db
      .prepare("SELECT path, tags FROM notes WHERE vault_id = ? ORDER BY path")
      .all(vault.id) as Array<{ path: string; tags: string }>;
    for (const r of rows) {
      if (sub !== undefined && r.path !== sub && !r.path.startsWith(`${sub}/`)) continue;
      if (!readableRel(ctx.acl, r.path, ctx.grantedScopes)) continue;
      if (scanned >= maxNotes) break;
      scanned++;
      for (const t of JSON.parse(r.tags) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  } else {
    const entries = walkVault(vault.root, { sub, extensions: [".md"] }).filter((e) =>
      readableRel(ctx.acl, e.relPath, ctx.grantedScopes),
    );
    for (const e of entries) {
      if (scanned >= maxNotes) break;
      scanned++;
      for (const t of noteTags(readNote(resolveVaultPath(vault.root, e.relPath)).raw, e.relPath)
        .all)
        counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return { notes_scanned: scanned, counts };
}
