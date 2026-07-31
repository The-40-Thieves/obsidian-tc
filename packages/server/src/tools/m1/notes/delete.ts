// WP8: notes-tools.ts split. delete_note — extracted verbatim out of buildNotesTools. The only
// unconditionally destructive:true tool in this domain (gated in dispatch, not handler-side HITL
// like write_note/move_note/copy_note's conditional confirmation).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { hardDelete, noteExists, readNote, trashNote } from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import { captureSnapshot } from "../../../vault/snapshots";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { DeleteInput, DeleteNoteOutput } from "./schemas";

export function createDeleteNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
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
  });
}
