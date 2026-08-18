// WP8: notes-tools.ts split. The three content-mutation tools that write bytes into an EXISTING
// (or about-to-exist) note in place — write_note, append_note, patch_note — kept together because
// they share the write-path pattern: content-addressed compare-and-swap via optional prev_hash
// (concurrent_modification on mismatch), the writes.requireCas gate, and captureSnapshot /
// persistGovernedNote / markEffectCommitted for undo + reindex + idempotent-retry safety.
// move_note/copy_note (path mutation) and delete_note (removal) split out separately — see
// move-copy.ts and delete.ts.
//
// patch_note's anchor-resolution helpers (patchByHeading/patchByBlock/patchByPreamble and their
// shared PatchResult/removedSpan/HEADING/escapeRegExp) are private to this file: nothing else in
// the notes domain calls them, so they are not promoted to a shared module.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { noteQualityWarningFor } from "../../../experiential/note-quality";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { parseNote, serializeNote } from "../../../vault/frontmatter";
import { requireConfirmation } from "../../../vault/hitl";
import { noteExists, readNote, writeNoteAtomic } from "../../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import { persistGovernedNote } from "../../../vault/persist-note";
import { captureSnapshot } from "../../../vault/snapshots";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import {
  AppendInput,
  AppendNoteOutput,
  PatchInput,
  PatchNoteOutput,
  WriteInput,
  WriteNoteOutput,
} from "./schemas";

// ── patch_note's private anchor-resolution helpers ─────────────────────────────

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** THE-603: what a patch* helper produced, plus the blast radius of a `replace` — the count and
 *  byte size of lines the operation actually discarded (always 0 for append/prepend, which only
 *  insert). `bodyLineCount` is the WHOLE body's line count (not just the targeted section), so a
 *  caller can judge "removed most of the note" rather than just "removed a lot of lines". */
interface PatchResult {
  body: string;
  removedLines: number;
  removedBytes: number;
  bodyLineCount: number;
}

function removedSpan(lines: string[], from: number, to: number, eol: string): [number, number] {
  const removed = lines.slice(from, to);
  return [removed.length, removed.length > 0 ? Buffer.byteLength(removed.join(eol), "utf8") : 0];
}

/** Insert/replace content relative to a heading section. Returns null if the
 *  heading is not found. The section spans the heading line to the next heading
 *  of the same or higher level (or EOF). `eol` preserves the note's line ending. */
function patchByHeading(
  body: string,
  op: "append" | "prepend" | "replace",
  target: string,
  content: string,
  eol: string,
): PatchResult | null {
  const lines = body.split(/\r?\n/);
  const want = target.trim().toLowerCase();
  let hi = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i] ?? "");
    if (m && (m[2] ?? "").trim().toLowerCase() === want) {
      hi = i;
      level = (m[1] ?? "").length;
      break;
    }
  }
  if (hi < 0) return null;
  let end = lines.length;
  for (let j = hi + 1; j < lines.length; j++) {
    const m = HEADING.exec(lines[j] ?? "");
    if (m && (m[1] ?? "").length <= level) {
      end = j;
      break;
    }
  }
  const ins = content.split(/\r?\n/);
  let next: string[];
  let removedLines = 0;
  let removedBytes = 0;
  if (op === "prepend") next = [...lines.slice(0, hi + 1), ...ins, ...lines.slice(hi + 1)];
  else if (op === "append") next = [...lines.slice(0, end), ...ins, ...lines.slice(end)];
  else {
    [removedLines, removedBytes] = removedSpan(lines, hi + 1, end, eol);
    next = [...lines.slice(0, hi + 1), ...ins, ...lines.slice(end)];
  }
  return { body: next.join(eol), removedLines, removedBytes, bodyLineCount: lines.length };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** THE-198: insert/replace content relative to a block reference (`^block-id`).
 *  The block spans backward from the `^id` line to the paragraph start (a blank
 *  line, a heading, or body start). Returns null when the block id is absent. */
function patchByBlock(
  body: string,
  op: "append" | "prepend" | "replace",
  blockId: string,
  content: string,
  eol: string,
): PatchResult | null {
  const lines = body.split(/\r?\n/);
  const re = new RegExp(`(?:^|\\s)\\^${escapeRegExp(blockId)}\\s*$`);
  let bi = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) {
      bi = i;
      break;
    }
  }
  if (bi < 0) return null;
  let start = bi;
  while (start > 0) {
    const prev = lines[start - 1] ?? "";
    if (prev.trim() === "" || HEADING.test(prev)) break;
    start--;
  }
  const ins = content.split(/\r?\n/);
  let next: string[];
  let removedLines = 0;
  let removedBytes = 0;
  if (op === "prepend") next = [...lines.slice(0, start), ...ins, ...lines.slice(start)];
  else if (op === "append") next = [...lines.slice(0, bi + 1), ...ins, ...lines.slice(bi + 1)];
  else {
    [removedLines, removedBytes] = removedSpan(lines, start, bi + 1, eol);
    next = [...lines.slice(0, start), ...ins, ...lines.slice(bi + 1)];
  }
  return { body: next.join(eol), removedLines, removedBytes, bodyLineCount: lines.length };
}

/** THE-198: insert/replace content in the body preamble — the region above the
 *  first heading (the frontmatter-adjacent top of the note). Always resolvable. */
function patchByPreamble(
  body: string,
  op: "append" | "prepend" | "replace",
  content: string,
  eol: string,
): PatchResult {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (HEADING.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const ins = content.split(/\r?\n/);
  let next: string[];
  let removedLines = 0;
  let removedBytes = 0;
  if (op === "prepend") next = [...ins, ...lines];
  else if (op === "append") next = [...lines.slice(0, end), ...ins, ...lines.slice(end)];
  else {
    [removedLines, removedBytes] = removedSpan(lines, 0, end, eol);
    next = [...ins, ...lines.slice(end)];
  }
  return { body: next.join(eol), removedLines, removedBytes, bodyLineCount: lines.length };
}

// ── tools ────────────────────────────────────────────────────────────────────

export function createWriteNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "write_note",
    domain: "notes",
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    pathAcl: (input) => [{ op: "write", path: input.path }],
    description:
      "Create, overwrite, or upsert a note. Optional prev_hash gives compare-and-swap; overwriting a non-empty note requires confirmation.",
    inputSchema: WriteInput,
    outputSchema: WriteNoteOutput,
    requiredScopes: ["write:notes"],
    // THE-824: display-only — see ToolDefinition.conditionallyDestructive. The real gate stays the
    // requireConfirmation call below (overwriting a non-empty note); this only stops the wire
    // annotation from advertising destructive: false for a tool that CAN demand confirmation.
    conditionallyDestructive: true,
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const rel = normalizeVaultPath(input.path);
      const abs = resolveVaultPath(v.root, rel);
      enforcePathAcl(ctx.acl, "write", rel, v.root);
      const ex = noteExists(abs);
      if (ex.exists && ex.type === "folder")
        throw err.invalidInput("path is a folder", { path: rel });
      if (input.mode === "create" && ex.exists)
        throw err.noteExists("note already exists; use overwrite or upsert", { path: rel });
      if (input.mode === "overwrite" && !ex.exists)
        throw err.noteNotFound("note does not exist; use create or upsert", { path: rel });
      // Gate CAS on whether the op actually overwrites existing content — not the literal
      // mode string. `upsert` on an existing note takes the same clobber path as `overwrite`
      // (reports mode_used:"overwrite" below), so it must satisfy requireCas too.
      const willOverwrite = input.mode === "overwrite" || (input.mode === "upsert" && ex.exists);
      if (deps.requireCas && willOverwrite && input.prev_hash === undefined)
        throw err.invalidInput(
          "prev_hash is required to overwrite an existing note when writes.requireCas is enabled; read the note first",
          { path: rel },
        );

      let prevHash: string | null = null;
      let prevEmpty = true;
      if (ex.exists) {
        const cur = readNote(abs);
        prevHash = cur.hash;
        prevEmpty = cur.raw.length === 0;
        if (input.prev_hash !== undefined && input.prev_hash !== cur.hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: cur.hash,
          });
      }

      const needsConfirm = ex.exists && !prevEmpty;
      requireConfirmation(ctx, "write_note", input, needsConfirm, {
        path: rel,
        mode: input.mode,
        prev_hash: prevHash,
      });

      persistGovernedNote(
        ctx.db,
        {
          snapshots: deps.snapshots,
          reindex: deps.reindex,
          now: ctx.now,
          markEffectCommitted: ctx.markEffectCommitted,
        },
        {
          vaultId: v.id,
          root: v.root,
          rel,
          content: input.content,
          op: "write_note",
          createDirs: input.options.create_dirs,
        },
      );
      return {
        vault: v.id,
        path: rel,
        created: !ex.exists,
        mode_used: ex.exists ? "overwrite" : "create",
        content_hash: contentHash(input.content),
        prev_hash: prevHash,
        bytes_written: Buffer.byteLength(input.content, "utf8"),
        // THE-643 item 1: never recomputed here — a point read of whatever the offline/scheduled
        // note-quality pass last wrote. null (not deps.edb) means "rollup never ran for this note".
        quality_warning: deps.edb ? noteQualityWarningFor(deps.edb, v.id, rel) : null,
      };
    },
  });
}

export function createAppendNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "append_note",
    domain: "notes",
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    pathAcl: (input) => [{ op: "write", path: input.path }],
    description: "Append content to a note (optionally creating it), preserving existing bytes.",
    inputSchema: AppendInput,
    outputSchema: AppendNoteOutput,
    requiredScopes: ["write:notes"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const rel = normalizeVaultPath(input.path);
      const abs = resolveVaultPath(v.root, rel);
      enforcePathAcl(ctx.acl, "write", rel, v.root);
      const ex = noteExists(abs);
      if (ex.exists && ex.type === "folder")
        throw err.invalidInput("path is a folder", { path: rel });

      let prevHash: string | null = null;
      let prevRaw: string | null = null;
      let next: string;
      if (ex.exists) {
        if (deps.requireCas && input.prev_hash === undefined)
          throw err.invalidInput(
            "prev_hash is required to append to an existing note when writes.requireCas is enabled; read the note first",
            { path: rel },
          );
        const cur = readNote(abs);
        prevHash = cur.hash;
        prevRaw = cur.raw;
        if (input.prev_hash !== undefined && input.prev_hash !== cur.hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: cur.hash,
          });
        const sep =
          input.ensure_newline && cur.raw.length > 0 && !cur.raw.endsWith("\n") ? "\n" : "";
        next = cur.raw + sep + input.content;
      } else {
        if (!input.create_if_missing)
          throw err.noteNotFound("note not found; set create_if_missing to create it", {
            path: rel,
          });
        next = input.content;
      }

      // THE-572: append is the one write in this file that is NOT idempotent — re-running it
      // concatenates the content a second time — and it is keyed through the nested
      // `options.idempotency_key` that WriteOptions carries. Before this signal, a throw between
      // the snapshot/write below and the handler's return released the claim, and a retry with
      // the same key appended `content` again on top of the already-appended file. Marked
      // write-ahead of the first durable effect (the snapshot row).
      ctx.markEffectCommitted?.();
      if (prevRaw !== null)
        captureSnapshot(ctx.db, deps.snapshots, v.id, rel, prevRaw, "append_note", ctx.now);
      writeNoteAtomic(abs, next, input.options.create_dirs);
      deps.reindex?.(v.id, rel, next);
      return {
        vault: v.id,
        path: rel,
        created: !ex.exists,
        content_hash: contentHash(next),
        prev_hash: prevHash,
        bytes_written: Buffer.byteLength(next, "utf8"),
        // THE-643 item 1: see write_note's identical comment above.
        quality_warning: deps.edb ? noteQualityWarningFor(deps.edb, v.id, rel) : null,
      };
    },
  });
}

export function createPatchNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "patch_note",
    domain: "notes",
    vaultArg: "vault",
    pathAcl: (input) => [{ op: "write", path: input.path }],
    description:
      'Insert or replace content (append/prepend/replace) relative to an anchor: a heading section, a block reference (anchor:{type:"block",block_id}), or the note preamble above the first heading (anchor:{type:"frontmatter"}). Frontmatter is preserved. A replace on a heading anchor that would discard more than 20 lines AND over half of the note\'s body (e.g. the note\'s only H1, which no lower-or-equal heading bounds) is refused unless confirm_replace is set. Snapshots (restore_note\'s undo) are captured only when the server\'s snapshots.enabled config is on; the default "trusted-local" posture leaves it on, so such a write is rollback-able via restore_note unless snapshots have been explicitly disabled.',
    inputSchema: PatchInput,
    outputSchema: PatchNoteOutput,
    requiredScopes: ["write:notes"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const rel = normalizeVaultPath(input.path);
      const abs = resolveVaultPath(v.root, rel);
      enforcePathAcl(ctx.acl, "write", rel, v.root);
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
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const parsed = parseNote(raw, rel);
      const anchor = input.anchor ?? {
        type: "heading" as const,
        heading: input.target_heading as string,
      };
      let patched: PatchResult | null;
      if (anchor.type === "heading")
        patched = patchByHeading(parsed.body, input.operation, anchor.heading, input.content, eol);
      else if (anchor.type === "block")
        patched = patchByBlock(parsed.body, input.operation, anchor.block_id, input.content, eol);
      else patched = patchByPreamble(parsed.body, input.operation, input.content, eol);
      if (patched === null)
        throw err.invalidInput(
          anchor.type === "block" ? "block reference not found" : "target heading not found",
          { path: rel, anchor },
        );

      // THE-603: a replace on a heading anchor is the only shape that can consume the ENTIRE
      // body with no terminator to bound it (a lone H1 has no same-or-higher heading below it —
      // see patchByHeading's comment). Two conditions, deliberately: an absolute floor so small
      // notes never trip this, AND a proportional floor so a normal section replace (which
      // rarely removes half a note) is unaffected — only the cliff case, not the common one.
      if (
        anchor.type === "heading" &&
        input.operation === "replace" &&
        patched.removedLines > 20 &&
        patched.removedLines > patched.bodyLineCount * 0.5 &&
        !input.confirm_replace
      )
        throw err.invalidInput(
          `replace would remove ${patched.removedLines} of ${patched.bodyLineCount} lines in the note body (heading "${anchor.heading}" has no lower-or-equal heading below it to bound the section). Set confirm_replace: true to proceed, or narrow the anchor to a subsection.`,
          {
            path: rel,
            anchor,
            lines_removed: patched.removedLines,
            body_line_count: patched.bodyLineCount,
          },
        );

      const next = serializeNote(parsed.frontmatter, patched.body, parsed.rawFrontmatter);
      // THE-603/THE-648: captureSnapshot silently no-ops when config.snapshots.enabled is false
      // (opt-out from the now-on-by-default "trusted-local" posture) — surface that gap for a
      // destructive replace instead of letting the "safety net" call succeed while writing nothing.
      if (input.operation === "replace" && !deps.snapshots?.enabled)
        deps.onSnapshotSkipped?.(v.id, rel, "patch_note");
      captureSnapshot(ctx.db, deps.snapshots, v.id, rel, raw, "patch_note", ctx.now);
      writeNoteAtomic(abs, next, false);
      deps.reindex?.(v.id, rel, next);
      return {
        vault: v.id,
        path: rel,
        operation: input.operation,
        anchor,
        ...(anchor.type === "heading" ? { target_heading: anchor.heading } : {}),
        content_hash: contentHash(next),
        prev_hash: hash,
        lines_removed: patched.removedLines,
        bytes_removed: patched.removedBytes,
        // THE-643 item 1: see write_note's identical comment above.
        quality_warning: deps.edb ? noteQualityWarningFor(deps.edb, v.id, rel) : null,
      };
    },
  });
}
