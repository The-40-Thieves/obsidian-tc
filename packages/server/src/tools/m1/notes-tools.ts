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

/** Insert/replace content relative to a heading section. Returns null if the
 *  heading is not found. The section spans the heading line to the next heading
 *  of the same or higher level (or EOF). `eol` preserves the note's line ending. */
function patchByHeading(
  body: string,
  op: "append" | "prepend" | "replace",
  target: string,
  content: string,
  eol: string,
): string | null {
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
  if (op === "prepend") next = [...lines.slice(0, hi + 1), ...ins, ...lines.slice(hi + 1)];
  else if (op === "append") next = [...lines.slice(0, end), ...ins, ...lines.slice(end)];
  else next = [...lines.slice(0, hi + 1), ...ins, ...lines.slice(end)];
  return next.join(eol);
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
): string | null {
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
  if (op === "prepend") next = [...lines.slice(0, start), ...ins, ...lines.slice(start)];
  else if (op === "append") next = [...lines.slice(0, bi + 1), ...ins, ...lines.slice(bi + 1)];
  else next = [...lines.slice(0, start), ...ins, ...lines.slice(bi + 1)];
  return next.join(eol);
}

/** THE-198: insert/replace content in the body preamble — the region above the
 *  first heading (the frontmatter-adjacent top of the note). Always resolvable. */
function patchByPreamble(
  body: string,
  op: "append" | "prepend" | "replace",
  content: string,
  eol: string,
): string {
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
  if (op === "prepend") next = [...ins, ...lines];
  else if (op === "append") next = [...lines.slice(0, end), ...ins, ...lines.slice(end)];
  else next = [...ins, ...lines.slice(end)];
  return next.join(eol);
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

// ── schemas ──────────────────────────────────────────────────────────────────

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
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description: "Read a note's raw content, parsed frontmatter, body, content hash, and stat.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
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
      pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
      description:
        "Batch-read notes. Returns successful notes and a per-path error list (partial).",
      inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(100) }).strict(),
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
      description: "List notes under a folder (read-ACL filtered), with cursor pagination.",
      inputSchema: ListInput,
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
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description: "Check whether a path exists in the vault and whether it is a file or folder.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
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
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Create, overwrite, or upsert a note. Optional prev_hash gives compare-and-swap; overwriting a non-empty note requires confirmation.",
      inputSchema: WriteInput,
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
          { snapshots: deps.snapshots, reindex: deps.reindex, now: ctx.now },
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
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description: "Append content to a note (optionally creating it), preserving existing bytes.",
      inputSchema: AppendInput,
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
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        'Insert or replace content (append/prepend/replace) relative to an anchor: a heading section, a block reference (anchor:{type:"block",block_id}), or the note preamble above the first heading (anchor:{type:"frontmatter"}). Frontmatter is preserved.',
      inputSchema: PatchInput,
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
        let patchedBody: string | null;
        if (anchor.type === "heading")
          patchedBody = patchByHeading(
            parsed.body,
            input.operation,
            anchor.heading,
            input.content,
            eol,
          );
        else if (anchor.type === "block")
          patchedBody = patchByBlock(
            parsed.body,
            input.operation,
            anchor.block_id,
            input.content,
            eol,
          );
        else patchedBody = patchByPreamble(parsed.body, input.operation, input.content, eol);
        if (patchedBody === null)
          throw err.invalidInput(
            anchor.type === "block" ? "block reference not found" : "target heading not found",
            { path: rel, anchor },
          );
        const next = serializeNote(parsed.frontmatter, patchedBody, parsed.rawFrontmatter);
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
        };
      },
    }),

    defineTool({
      name: "delete_note",
      pathAcl: (input) => [{ op: "delete", path: input.path }],
      description:
        "Delete a note (to the vault's .trash mirror, or permanently). Destructive — requires confirmation.",
      inputSchema: DeleteInput,
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
      // Backlink rewrites in other notes are a deliberate integrity carve-out (like move_attachment,
      // N-3) and stay handler-enforced; the ACL-gated paths are the source (delete) + dest (write).
      pathAcl: (input) => [
        { op: "delete", path: input.from },
        { op: "write", path: input.to },
      ],
      description:
        "Move/rename a note and update backlinks. Crossing a folder boundary OR overwriting an existing destination requires confirmation; an overwritten destination is soft-deleted to .trash (recoverable).",
      inputSchema: MoveInput,
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
      pathAcl: (input) => [
        { op: "read", path: input.from },
        { op: "write", path: input.to },
      ],
      description: "Copy a note to a new path (backlinks are not rewritten for copies).",
      inputSchema: CopyInput,
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
