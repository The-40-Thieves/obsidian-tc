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
//
// WP8 (post-refactor-program follow-up — not one of docs/plans/2026-07-30-codebase-refactor-map.md's
// original six targets; this file was 1,042 lines and became the largest production source file
// only after that program finished): this file is now a compatibility facade over ./notes/*, the
// same pattern WP2 established for m7/knowledge-tools.ts. `buildNotesTools` is the only symbol
// this file ever exported, and it still is — see m1-notes-tool-metadata-parity.test.ts (the
// ordered public metadata of all 10 tools) and check-facade-parity.mjs (this file's re-export
// surface) for the invariants that pin that.
//
// Split by mutation shape, not mechanically one-file-per-tool: read_note/read_notes (single vs.
// batch read) -> notes/read.ts; list_notes/note_exists (lightweight lookups) -> notes/list.ts;
// write_note/append_note/patch_note (in-place content mutation sharing the CAS + snapshot +
// markEffectCommitted write-path pattern) -> notes/write.ts; move_note/copy_note (path
// relocation/duplication sharing the overwrite-then-trash-destination shape) ->
// notes/move-copy.ts; delete_note (the one unconditionally destructive:true tool) ->
// notes/delete.ts. All 23 Zod schemas live in notes/schemas.ts, the same shared-schemas-module
// shape WP2 used for M7.
import type { ToolDefinition } from "../../mcp/registry";
import { createDeleteNoteTool } from "./notes/delete";
import { createListNotesTool, createNoteExistsTool } from "./notes/list";
import { createCopyNoteTool, createMoveNoteTool } from "./notes/move-copy";
import { createReadNotesTool, createReadNoteTool } from "./notes/read";
import { createAppendNoteTool, createPatchNoteTool, createWriteNoteTool } from "./notes/write";
import type { M1Deps } from "./shared";

export function buildNotesTools(deps: M1Deps): ToolDefinition[] {
  return [
    createReadNoteTool(deps),
    createReadNotesTool(deps),
    createListNotesTool(deps),
    createNoteExistsTool(deps),
    createWriteNoteTool(deps),
    createAppendNoteTool(deps),
    createPatchNoteTool(deps),
    createDeleteNoteTool(deps),
    createMoveNoteTool(deps),
    createCopyNoteTool(deps),
  ];
}
