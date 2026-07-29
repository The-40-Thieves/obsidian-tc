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
import {
  err,
  ObsidianTcError,
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { parseNote, serializeNote } from "../../vault/frontmatter";
import { requireConfirmation } from "../../vault/hitl";
import { buildVaultIndex, resolveTarget } from "../../vault/links";
import {
  hardDelete,
  noteExists,
  readNote,
  statNote,
  trashNote,
  writeNoteAtomic,
} from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { persistGovernedNote } from "../../vault/persist-note";
import { rewriteLinks } from "../../vault/rewrite";
import { captureSnapshot } from "../../vault/snapshots";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

// ── helpers ──────────────────────────────────────────────────────────────────

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function basenameNoExt(p: string): string {
  const b = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  return b.replace(/\.md$/i, "");
}

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

// ── output schemas ───────────────────────────────────────────────────────────
// THE-417 Phase 1: written from each handler's RETURN STATEMENTS, not from the io/frontmatter
// types the data is built from — parseNote/statNote/captureSnapshot etc. get renamed, derived, or
// conditionally spread on the way out, so a schema copied from their interfaces would be wrong.
// Conditional spreads (`...(cond ? { x } : {})`) are `.optional()`, never `.nullable()`.

/** Mirrors vault/frontmatter.ts's ParsedNote.frontmatter: null when the note has no `---` block,
 *  otherwise the parsed YAML mapping (shape genuinely unknown per key). */
const FrontmatterOut = z.record(z.string(), z.unknown()).nullable();

/** Mirrors vault/notes-io.ts's NoteStat; null when statNote's statSync throws (e.g. the file
 *  vanished between the existence check and the stat — a race, not a validation failure). */
const NoteStatOut = z.object({ size: z.number(), mtime: z.string(), ctime: z.string() }).nullable();

const ReadNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  content: z.string(),
  frontmatter: FrontmatterOut,
  body: z.string(),
  has_frontmatter: z.boolean(),
  content_hash: z.string(),
  stat: NoteStatOut,
});

/** read_notes' per-note entry is hand-assembled in the loop below and is NARROWER than
 *  ReadNoteOutput — no has_frontmatter, no stat. */
const ReadNotesEntry = z.object({
  path: z.string(),
  content: z.string(),
  frontmatter: FrontmatterOut,
  body: z.string(),
  content_hash: z.string(),
});

const ReadNotesError = z.object({ path: z.string(), code: z.string(), message: z.string() });

const ReadNotesOutput = z.object({
  vault: z.string(),
  notes: z.array(ReadNotesEntry),
  errors: z.array(ReadNotesError),
});

const ListNotesOutput = z.object({
  vault: z.string(),
  folder: z.string(),
  notes: z.array(z.object({ path: z.string(), size: z.number(), mtime: z.number() })),
  next_cursor: z.string().nullable(),
  total_returned: z.number(),
});

const NoteExistsOutput = z.object({
  vault: z.string(),
  path: z.string(),
  exists: z.boolean(),
  type: z.enum(["file", "folder"]).nullable(),
});

const WriteNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  created: z.boolean(),
  mode_used: z.enum(["create", "overwrite"]),
  content_hash: z.string(),
  prev_hash: z.string().nullable(),
  bytes_written: z.number(),
});

const AppendNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  created: z.boolean(),
  content_hash: z.string(),
  prev_hash: z.string().nullable(),
  bytes_written: z.number(),
});

/** Mirrors the PatchAnchor input union verbatim — patch_note echoes the resolved anchor back. */
const PatchAnchorOut = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), heading: z.string() }),
  z.object({ type: z.literal("block"), block_id: z.string() }),
  z.object({ type: z.literal("frontmatter") }),
]);

const PatchNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  operation: z.enum(["append", "prepend", "replace"]),
  anchor: PatchAnchorOut,
  // Present only when anchor.type === "heading" (legacy target_heading echo) — omitted, not
  // null, for the block/frontmatter arms.
  target_heading: z.string().optional(),
  content_hash: z.string(),
  // Not nullable: reached only after readNote() on a note whose existence was already confirmed.
  prev_hash: z.string(),
  // THE-603: the blast radius of this write. 0 for append/prepend, which only insert; a
  // catastrophic replace and a two-line replace used to return structurally identical payloads.
  lines_removed: z.number(),
  bytes_removed: z.number(),
});

const DeleteNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  deleted: z.literal(true),
  permanent: z.boolean(),
  trashed_to: z.string().nullable(),
  // Not nullable: same reasoning as patch_note's prev_hash.
  prev_hash: z.string(),
});

const MoveNoteOutput = z.object({
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  moved: z.literal(true),
  overwritten: z.boolean(),
  trashed_dest_to: z.string().nullable(),
  content_hash: z.string(),
  backlinks_updated: z.object({ notes: z.number(), links: z.number() }),
});

const CopyNoteOutput = z.object({
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  copied: z.literal(true),
  overwritten: z.boolean(),
  trashed_dest_to: z.string().nullable(),
  content_hash: z.string(),
});

// ── input schemas ────────────────────────────────────────────────────────────

const WriteMode = z.enum(["create", "overwrite", "upsert"]);

const WriteInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    content: z.string(),
    mode: WriteMode.default("create"),
    prev_hash: z.string().optional(),
    options: WriteOptions.prefault({}),
  })
  .strict();

const AppendInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    content: z.string(),
    create_if_missing: z.boolean().default(false),
    ensure_newline: z.boolean().default(true),
    prev_hash: z.string().optional(),
    options: WriteOptions.prefault({}),
  })
  .strict();

// THE-198: target a heading section, a block reference (^id), or the frontmatter preamble.
const PatchAnchor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), heading: z.string().min(1) }).strict(),
  z.object({ type: z.literal("block"), block_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("frontmatter") }).strict(),
]);

const PatchInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    operation: z.enum(["append", "prepend", "replace"]),
    // Legacy shorthand, equivalent to anchor:{type:"heading",heading}. Retained for back-compat.
    target_heading: z.string().min(1).optional(),
    anchor: PatchAnchor.optional(),
    content: z.string(),
    prev_hash: z.string().optional(),
    // THE-603: required (set true) only when operation:"replace" on a heading anchor would discard
    // more than 20 lines AND over half of the note's body — e.g. replacing a note's only H1, which
    // has no same-or-higher-level heading to bound it and so consumes the entire document below
    // it. Ignored for append/prepend and for block/frontmatter anchors, which cannot hit this.
    confirm_replace: z.boolean().default(false),
  })
  .strict()
  .refine((i) => i.anchor !== undefined || i.target_heading !== undefined, {
    message: "either anchor or target_heading is required",
  });

const MoveInput = z
  .object({
    vault: VaultId,
    from: VaultPath,
    to: VaultPath,
    overwrite: z.boolean().default(false),
    update_backlinks: z.boolean().default(true),
    prev_hash: z.string().optional(),
    options: WriteOptions.prefault({}),
  })
  .strict();

const CopyInput = z
  .object({
    vault: VaultId,
    from: VaultPath,
    to: VaultPath,
    overwrite: z.boolean().default(false),
    options: WriteOptions.prefault({}),
  })
  .strict();

const DeleteInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    permanent: z.boolean().default(false),
    prev_hash: z.string().optional(),
  })
  .strict();

const ListInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    recursive: z.boolean().default(true),
    extensions: z.array(z.string().min(1)).optional(),
  })
  .merge(Pagination)
  .strict();

// ── tools ────────────────────────────────────────────────────────────────────

export function buildNotesTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_note",
      domain: "notes",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description: "Read a note's raw content, parsed frontmatter, body, content hash, and stat.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      outputSchema: ReadNoteOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { vault: v.id, path: rel });
        const { raw, hash } = readNote(abs);
        const parsed = parseNote(raw);
        return {
          vault: v.id,
          path: rel,
          content: raw,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          has_frontmatter: parsed.hasFrontmatter,
          content_hash: hash,
          stat: statNote(abs),
        };
      },
    }),

    defineTool({
      name: "read_notes",
      domain: "notes",
      pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
      description:
        "Batch-read notes. Returns successful notes and a per-path error list (partial).",
      inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(100) }).strict(),
      outputSchema: ReadNotesOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const notes: Array<Record<string, unknown>> = [];
        const errors: Array<{ path: string; code: string; message: string }> = [];
        for (const p of input.paths) {
          try {
            const rel = normalizeVaultPath(p);
            const abs = resolveVaultPath(v.root, rel);
            enforcePathAcl(ctx.acl, "read", rel, v.root);
            const ex = noteExists(abs);
            if (!ex.exists || ex.type === "folder")
              throw err.noteNotFound("note not found", { path: rel });
            const { raw, hash } = readNote(abs);
            const parsed = parseNote(raw);
            notes.push({
              path: rel,
              content: raw,
              frontmatter: parsed.frontmatter,
              body: parsed.body,
              content_hash: hash,
            });
          } catch (e) {
            const code = e instanceof ObsidianTcError ? e.code : "internal_error";
            errors.push({ path: p, code, message: (e as Error).message });
          }
        }
        return { vault: v.id, notes, errors };
      },
    }),

    defineTool({
      name: "list_notes",
      domain: "notes",
      description: "List notes under a folder (read-ACL filtered), with cursor pagination.",
      inputSchema: ListInput,
      outputSchema: ListNotesOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const entries = walkVault(v.root, {
          sub,
          recursive: input.recursive,
          extensions: input.extensions ?? [".md"],
        }).filter((e) => readableRel(ctx.acl, e.relPath));
        const after = input.cursor;
        const visible = after ? entries.filter((e) => e.relPath > after) : entries;
        const limit = input.limit ?? 200;
        const page = visible.slice(0, limit);
        const next = visible.length > limit ? (page[page.length - 1]?.relPath ?? null) : null;
        return {
          vault: v.id,
          folder: sub ?? "",
          notes: page.map((e) => ({ path: e.relPath, size: e.size, mtime: e.mtime })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),

    defineTool({
      name: "note_exists",
      domain: "notes",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description: "Check whether a path exists in the vault and whether it is a file or folder.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      outputSchema: NoteExistsOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        return { vault: v.id, path: rel, exists: ex.exists, type: ex.type ?? null };
      },
    }),

    defineTool({
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
        };
      },
    }),

    defineTool({
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
        };
      },
    }),

    defineTool({
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
        const parsed = parseNote(raw);
        const anchor = input.anchor ?? {
          type: "heading" as const,
          heading: input.target_heading as string,
        };
        let patched: PatchResult | null;
        if (anchor.type === "heading")
          patched = patchByHeading(
            parsed.body,
            input.operation,
            anchor.heading,
            input.content,
            eol,
          );
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
        };
      },
    }),

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
