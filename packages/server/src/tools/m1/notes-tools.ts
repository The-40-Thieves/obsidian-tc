// Domain 2 — File/note CRUD (G2.1 r2). Ten tools over the vault filesystem:
// read_note, read_notes, list_notes, note_exists, write_note, append_note,
// patch_note, delete_note, move_note, copy_note. Every path-based handler funnels
// through resolveVaultPath (containment guard -> path_invalid) and enforcePathAcl
// (per-path whitelist -> acl_denied). Writes are content-addressed: an optional
// prev_hash gives compare-and-swap (concurrent_modification on mismatch) and every
// write returns content_hash + mode_used. Confirmation is split by intent:
// delete_note is destructive:true and gates in dispatch; write_note (overwriting a
// non-empty note), move_note (crossing a folder boundary or overwriting), and
// copy_note (overwriting an existing note) gate conditionally in the handler via
// requireConfirmation, so ordinary creates, dry moves, and non-overwriting copies
// never demand a token.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { buildVaultIndex, resolveTarget } from "../../vault/links";
import { hardDelete, noteExists, readNote, trashNote, writeNoteAtomic } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { rewriteLinks } from "../../vault/rewrite";
import { captureSnapshot } from "../../vault/snapshots";
import { defineTool } from "./define";
import { createListNotesTool, createNoteExistsTool } from "./notes/list";
import { createReadNotesTool, createReadNoteTool } from "./notes/read";
import {
  CopyInput,
  CopyNoteOutput,
  DeleteInput,
  DeleteNoteOutput,
  MoveInput,
  MoveNoteOutput,
} from "./notes/schemas";
import { createAppendNoteTool, createPatchNoteTool, createWriteNoteTool } from "./notes/write";
import type { M1Deps } from "./shared";

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

export function buildNotesTools(deps: M1Deps): ToolDefinition[] {
  return [
    createReadNoteTool(deps),
    createReadNotesTool(deps),
    createListNotesTool(deps),
    createNoteExistsTool(deps),
    createWriteNoteTool(deps),
    createAppendNoteTool(deps),
    createPatchNoteTool(deps),

    defineTool({
      name: "delete_note",
      domain: "notes",
      vaultArg: "vault",
      pathAcl: (input) => [{ op: "delete", path: input.path }],
      description:
        "Delete a note (to the vault's .trash mirror, or permanently). Destructive — requires confirmation. restore_note reads its undo from a snapshot, which is captured only when the server's snapshots.enabled config is on; the default \"trusted-local\" posture leaves it on, so a deleted note has a restore_note path back unless snapshots have been explicitly disabled.",
      inputSchema: DeleteInput,
      outputSchema: DeleteNoteOutput,
      requiredScopes: ["delete:notes"],
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "delete", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });
        // THE-603: delete_note is unconditionally destructive (destructive:true, gated in
        // dispatch) — the sharpest case for a silently inert snapshot no-op, since restore_note
        // is the documented undo and a permanent delete leaves no other recovery path at all.
        if (!deps.snapshots?.enabled) deps.onSnapshotSkipped?.(v.id, rel, "delete_note");
        captureSnapshot(ctx.db, deps.snapshots, v.id, rel, raw, "delete_note", ctx.now);
        let trashedTo: string | null = null;
        if (input.permanent) hardDelete(abs);
        else trashedTo = trashNote(v.root, rel);
        deps.deindex?.(v.id, rel);
        return {
          vault: v.id,
          path: rel,
          deleted: true,
          permanent: input.permanent,
          trashed_to: trashedTo,
          prev_hash: hash,
        };
      },
    }),

    defineTool({
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
        if (fromRel === toRel)
          throw err.invalidInput("from and to are identical", { path: fromRel });
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
    }),

    defineTool({
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
    }),
  ];
}
