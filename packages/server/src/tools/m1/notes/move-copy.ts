// WP8: notes-tools.ts split. move_note and copy_note — extracted verbatim out of
// buildNotesTools. Paired because both relocate/duplicate a note to a new path with the same
// overwrite-then-trash-destination shape (soft-delete the existing destination to .trash before
// writing over it, so overwritten content stays recoverable). move_note additionally rewrites
// backlinks in every other note that pointed at the old path — updateBacklinks below is private
// to move_note; copy_note does not rewrite links (see its description).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { requireConfirmation } from "../../../vault/hitl";
import { buildVaultIndex, resolveTarget } from "../../../vault/links";
import {
  hardDelete,
  noteExists,
  readNote,
  trashNote,
  writeNoteAtomic,
} from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../../vault/paths";
import { rewriteLinks } from "../../../vault/rewrite";
import { captureSnapshot } from "../../../vault/snapshots";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { CopyInput, CopyNoteOutput, MoveInput, MoveNoteOutput } from "./schemas";

// ── helpers ──────────────────────────────────────────────────────────────────

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function basenameNoExt(p: string): string {
  const b = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  return b.replace(/\.md$/i, "");
}

/** Rewrite links in every other note that pointed at the moved note. Runs after
 *  the file has moved on disk; reconstructs the pre-move path set so old-target
 *  links still resolve to fromRel, then repoints them at the new location. */
// ACL carve-out: this rewrites links in EVERY referencing note to keep links valid,
// including notes outside the caller's write whitelist. Deliberate graph-integrity
// invariant (a constrained link-text update, not arbitrary write access) — audit #12.
function updateBacklinks(
  root: string,
  fromRel: string,
  toRel: string,
): { notes: number; links: number; rewritten: Array<{ rel: string; text: string }> } {
  const postPaths = walkVault(root, { extensions: [".md"] }).map((e) => e.relPath);
  const oldPaths = postPaths.filter((p) => p !== toRel).concat(fromRel);
  const oldIndex = buildVaultIndex(oldPaths);
  const newIndex = buildVaultIndex(postPaths);
  const newBase = basenameNoExt(toRel);
  const unique = (newIndex.byBasename.get(newBase.toLowerCase()) ?? []).length === 1;
  const newTarget = unique ? newBase : toRel.replace(/\.md$/i, "");

  let notes = 0;
  let links = 0;
  const rewritten: Array<{ rel: string; text: string }> = [];
  for (const p of postPaths) {
    if (p === toRel) continue; // the moved note's own outgoing links are unaffected
    const abs = resolveVaultPath(root, p);
    const { raw } = readNote(abs);
    const { text, count } = rewriteLinks(raw, (target) => {
      const r = resolveTarget(oldIndex, target);
      return r.resolved && r.target_path === fromRel ? newTarget : null;
    });
    if (count > 0) {
      writeNoteAtomic(abs, text, false);
      rewritten.push({ rel: p, text });
      notes++;
      links += count;
    }
  }
  return { notes, links, rewritten };
}

// ── tools ────────────────────────────────────────────────────────────────────

export function createMoveNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "move_note",
    domain: "notes",
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    // Backlink rewrites in other notes are a deliberate integrity carve-out (like move_attachment,
    // N-3) and stay handler-enforced; the ACL-gated paths are the source (delete) + dest (write).
    pathAcl: (input) => [
      { op: "delete", path: input.from },
      { op: "write", path: input.to },
    ],
    description:
      "Move/rename a note and update backlinks. Crossing a folder boundary OR overwriting an existing destination requires confirmation; an overwritten destination is soft-deleted to .trash (recoverable).",
    inputSchema: MoveInput,
    outputSchema: MoveNoteOutput,
    requiredScopes: ["write:notes", "delete:notes"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const fromRel = normalizeVaultPath(input.from);
      const toRel = normalizeVaultPath(input.to);
      if (fromRel === toRel) throw err.invalidInput("from and to are identical", { path: fromRel });
      const fromAbs = resolveVaultPath(v.root, fromRel);
      const toAbs = resolveVaultPath(v.root, toRel);
      enforcePathAcl(ctx.acl, "delete", fromRel, v.root);
      enforcePathAcl(ctx.acl, "write", toRel, v.root);

      const fromEx = noteExists(fromAbs);
      if (!fromEx.exists || fromEx.type === "folder")
        throw err.noteNotFound("source note not found", { path: fromRel });
      const toEx = noteExists(toAbs);
      if (toEx.exists && toEx.type === "folder")
        throw err.invalidInput("destination is a folder", { path: toRel });
      if (toEx.exists && !input.overwrite)
        throw err.noteExists("destination already exists; set overwrite", { path: toRel });

      const { raw, hash } = readNote(fromAbs);
      if (input.prev_hash !== undefined && input.prev_hash !== hash)
        throw err.concurrentModification("note changed since prev_hash", {
          path: fromRel,
          expected: input.prev_hash,
          actual: hash,
        });

      const crossFolder = dirOf(fromRel) !== dirOf(toRel);
      const overwriteExisting = toEx.exists && input.overwrite;
      requireConfirmation(ctx, "move_note", input, crossFolder || overwriteExisting, {
        from: fromRel,
        to: toRel,
        overwrite: overwriteExisting,
      });

      // THE-572: the relocation below is self-protecting against a double MOVE (a retry finds the
      // source gone and answers note_not_found), but that answer is wrong — it blames a missing
      // source when the caller's own prior attempt moved it, and leaves updateBacklinks' rewrites
      // unfinished with no indication. Signalling here makes the retry an accurate
      // indeterminate_outcome, and stops an overwrite retry re-trashing the destination.
      ctx.markEffectCommitted?.();
      // On overwrite, soft-delete the destination first so its content is recoverable
      // (the source is hardDelete'd below, but its content survives at toRel).
      let trashedDestTo: string | null = null;
      if (overwriteExisting) {
        captureSnapshot(
          ctx.db,
          deps.snapshots,
          v.id,
          toRel,
          readNote(toAbs).raw,
          "move_note",
          ctx.now,
        );
        trashedDestTo = trashNote(v.root, toRel);
      }
      writeNoteAtomic(toAbs, raw, input.options.create_dirs);
      hardDelete(fromAbs);
      // THE-291: keep the search index coherent across the move — drop the source path,
      // index the destination, and reindex every backlink-rewritten note below.
      deps.deindex?.(v.id, fromRel);
      deps.reindex?.(v.id, toRel, raw);
      const backlinks = input.update_backlinks
        ? updateBacklinks(v.root, fromRel, toRel)
        : { notes: 0, links: 0, rewritten: [] };
      for (const rw of backlinks.rewritten) deps.reindex?.(v.id, rw.rel, rw.text);
      return {
        vault: v.id,
        from: fromRel,
        to: toRel,
        moved: true,
        overwritten: toEx.exists,
        trashed_dest_to: trashedDestTo,
        content_hash: hash,
        backlinks_updated: { notes: backlinks.notes, links: backlinks.links },
      };
    },
  });
}

export function createCopyNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "copy_note",
    domain: "notes",
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    pathAcl: (input) => [
      { op: "read", path: input.from },
      { op: "write", path: input.to },
    ],
    description: "Copy a note to a new path (backlinks are not rewritten for copies).",
    inputSchema: CopyInput,
    outputSchema: CopyNoteOutput,
    requiredScopes: ["write:notes"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const fromRel = normalizeVaultPath(input.from);
      const toRel = normalizeVaultPath(input.to);
      const fromAbs = resolveVaultPath(v.root, fromRel);
      const toAbs = resolveVaultPath(v.root, toRel);
      enforcePathAcl(ctx.acl, "read", fromRel, v.root);
      enforcePathAcl(ctx.acl, "write", toRel, v.root);

      const fromEx = noteExists(fromAbs);
      if (!fromEx.exists || fromEx.type === "folder")
        throw err.noteNotFound("source note not found", { path: fromRel });
      const toEx = noteExists(toAbs);
      if (toEx.exists && !input.overwrite)
        throw err.noteExists("destination already exists; set overwrite", { path: toRel });

      // Overwriting an existing destination is a conditional-HITL, recoverable op — mirror
      // move_note: require confirmation, then soft-delete the destination first so its prior
      // content survives in .trash. Without this, copy_note --overwrite clobbered the target
      // irreversibly with no HITL floor (the sibling move_note already guarded this).
      const overwriteExisting = toEx.exists && input.overwrite;
      requireConfirmation(ctx, "copy_note", input, overwriteExisting, {
        from: fromRel,
        to: toRel,
        overwrite: overwriteExisting,
      });

      const { raw, hash } = readNote(fromAbs);
      // THE-572: unlike move_note this leaves the source in place, so a retry re-runs the WHOLE
      // sequence — under overwrite that means a second .trash entry and a second snapshot row for
      // content that never changed. Signal before the first of those effects.
      ctx.markEffectCommitted?.();
      let trashedDestTo: string | null = null;
      if (overwriteExisting) {
        captureSnapshot(
          ctx.db,
          deps.snapshots,
          v.id,
          toRel,
          readNote(toAbs).raw,
          "copy_note",
          ctx.now,
        );
        trashedDestTo = trashNote(v.root, toRel);
      }
      writeNoteAtomic(toAbs, raw, input.options.create_dirs);
      deps.reindex?.(v.id, toRel, raw);
      return {
        vault: v.id,
        from: fromRel,
        to: toRel,
        copied: true,
        overwritten: toEx.exists,
        trashed_dest_to: trashedDestTo,
        content_hash: hash,
      };
    },
  });
}
