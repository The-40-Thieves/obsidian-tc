// Domain 9 — Attachments. Five tools: list_attachments, get_attachment, write_attachment,
// move_attachment, delete_attachment. Attachments are ordinary binary vault files
// (images, PDFs, audio, video) addressed by vault-relative path, so every handler
// funnels through resolveVaultPath (containment) + enforcePathAcl (whitelist) like
// notes. get_attachment returns bytes base64-encoded under a size cap. move_attachment
// repoints note links to the moved file (reference-style preserved) and confirms only
// when crossing a folder boundary or overwriting; delete_attachment is destructive
// (dispatch-gated HITL) and soft-deletes to .trash unless permanent, reporting the
// notes that still reference it so the caller can see what it is about to break.
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ElicitToken,
  err,
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { isDefaultDenied } from "../../acl";
import {
  enforceMemoryDefenseOnNoteWrite,
  MEMORY_DEFENSE_OFF,
} from "../../experiential/memory-defense";
import { redactSecrets } from "../../experiential/redact";
import {
  checkBase64Payload,
  DEFAULT_ATTACHMENT_EXTS,
  findAttachmentReferences,
  isAttachment,
  mimeOf,
  resolveAttachmentFolder,
  resolveAttachmentWritePath,
  rewriteAttachmentReferences,
} from "../../formats/attachments";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { requireConfirmation } from "../../vault/hitl";
import {
  hardDelete,
  noteExists,
  readFileChecked,
  statNote,
  trashNote,
  writeFileAtomic,
} from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./shared";

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

const ListInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    extensions: z.array(z.string().min(1)).optional(),
    include_reference_count: z.boolean().default(false),
  })
  .merge(Pagination)
  .strict();

const GetInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    encoding: z.enum(["base64"]).default("base64"),
    max_bytes: z.number().int().positive().max(50_000_000).default(10_000_000),
    include_references: z.boolean().default(false),
  })
  .strict();

/** Hard ceiling on the base64 string a caller may send (the longest padded encoding of 50 MB, the
 *  same ceiling get_attachment's max_bytes has). The operator's `writes.maxAttachmentBytes` is
 *  enforced in the handler; this only keeps zod from scanning an absurd string. */
const MAX_WRITE_BASE64_CHARS = Math.ceil(50_000_000 / 3) * 4;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25_000_000;
/** Extensions that name a format with its own tools, so the refusal can point at them. */
const OWN_TOOL_EXTS = new Set([".md", ".canvas", ".base"]);

const WriteInput = z
  .object({
    vault: VaultId,
    // A bare filename lands in the vault's configured attachment folder; a path with a folder is
    // used as given (`./name.png` = the vault root).
    path: VaultPath,
    content: z.string().max(MAX_WRITE_BASE64_CHARS),
    mime_type: z.string().min(1).max(127).optional(),
    overwrite: z.boolean().default(false),
    options: WriteOptions.prefault({}),
    elicit_token: ElicitToken.optional(),
  })
  .strict();

const MoveInput = z
  .object({
    vault: VaultId,
    from: VaultPath,
    to: VaultPath,
    overwrite: z.boolean().default(false),
    update_references: z.boolean().default(true),
    options: WriteOptions.prefault({}),
    // THE-824: advertised so a caller can discover the HITL confirmation parameter via
    // describe_capability — stripped off rawArgs into ctx.elicitToken before this schema ever
    // validates it (mcp/server.ts), so declaring it here changes nothing about dispatch.
    elicit_token: ElicitToken.optional(),
  })
  .strict();

const DeleteInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    permanent: z.boolean().default(false),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// THE-417 Phase 1: declared output contracts, written from the RETURN STATEMENTS below (not from
// the WalkEntry/NoteStat types the data came from).
// ---------------------------------------------------------------------------------------------

/** list_attachments per-item shape. `mtime` here is WalkEntry.mtime — epoch millis (a number) —
 *  NOT the ISO-string mtime that statNote produces elsewhere in M3 (see periodic-tools.ts); two
 *  different helpers, two different representations, and this schema follows THIS handler's.
 *  `reference_count` is a conditional spread, so it is optional, present only when
 *  include_reference_count was requested. */
const AttachmentEntry = z.object({
  path: z.string(),
  size: z.number(),
  mtime: z.number(),
  mime: z.string(),
  reference_count: z.number().int().optional(),
});

const ListAttachmentsOutput = z.object({
  vault: z.string(),
  folder: z.string(),
  attachment_folder: z.string(),
  attachments: z.array(AttachmentEntry),
  next_cursor: z.string().nullable(),
  total_returned: z.number().int(),
});

/** get_attachment. `references` is a conditional spread (include_references), so optional —
 *  never returned as an empty array when omitted. */
const GetAttachmentOutput = z.object({
  vault: z.string(),
  path: z.string(),
  mime: z.string(),
  size: z.number(),
  encoding: z.literal("base64"),
  content: z.string(),
  references: z.array(z.string()).optional(),
});

const WriteAttachmentOutput = z.object({
  vault: z.string(),
  path: z.string(),
  created: z.boolean(),
  overwritten: z.boolean(),
  size: z.number().int(),
  mime: z.string(),
  sha256: z.string(),
  trashed_prev_to: z.string().nullable(),
});

const MoveAttachmentOutput = z.object({
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  moved: z.literal(true),
  overwritten: z.boolean(),
  trashed_dest_to: z.string().nullable(),
  references_updated: z.object({ notes: z.number().int(), refs: z.number().int() }),
});

const DeleteAttachmentOutput = z.object({
  vault: z.string(),
  path: z.string(),
  deleted: z.literal(true),
  permanent: z.boolean(),
  trashed_to: z.string().nullable(),
  size: z.number().nullable(),
  references: z.array(z.string()),
});

export function buildAttachmentTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_attachments",
      domain: "attachments",
      pathAcl: (input) => (input.folder ? [{ op: "read", path: input.folder }] : []),
      description:
        "List attachment files in the vault (filtered by extension, read-ACL aware), with cursor pagination. Optionally count referencing notes per file.",
      inputSchema: ListInput,
      outputSchema: ListAttachmentsOutput,
      requiredScopes: ["read:attachments"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root, ctx.grantedScopes);
        const exts = (input.extensions ?? DEFAULT_ATTACHMENT_EXTS).map((x) => x.toLowerCase());
        const entries = walkVault(v.root, { sub, recursive: true, extensions: exts }).filter((e) =>
          readableRel(ctx.acl, e.relPath, ctx.grantedScopes),
        );
        const after = input.cursor;
        const visible = after ? entries.filter((e) => e.relPath > after) : entries;
        const limit = input.limit ?? 200;
        const page = visible.slice(0, limit);
        const next = visible.length > limit ? (page[page.length - 1]?.relPath ?? null) : null;
        return {
          vault: v.id,
          folder: sub ?? "",
          attachment_folder: resolveAttachmentFolder(v.root),
          attachments: page.map((e) => ({
            path: e.relPath,
            size: e.size,
            mtime: e.mtime,
            mime: mimeOf(e.relPath),
            ...(input.include_reference_count
              ? {
                  reference_count: findAttachmentReferences(v.root, e.relPath).filter((p) =>
                    readableRel(ctx.acl, p, ctx.grantedScopes),
                  ).length,
                }
              : {}),
          })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),

    defineTool({
      name: "get_attachment",
      domain: "attachments",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Read an attachment's bytes (base64) plus MIME type and size. Fails with invalid_input when the file exceeds max_bytes. Domain: attachments.",
      inputSchema: GetInput,
      outputSchema: GetAttachmentOutput,
      requiredScopes: ["read:attachments"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        // N-1: read:attachments grants binary attachment reads, not arbitrary file reads — reject a
        // path whose extension is not in the attachment allowlist (list_attachments already filters);
        // notes are read with read_note under read:notes.
        if (!isAttachment(rel))
          throw err.invalidInput(
            "path is not an attachment (extension not in the allowlist); read notes with read_note",
            { path: rel },
          );
        const abs = resolveVaultPath(v.root, rel);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("attachment not found", { path: rel });
        const st = statNote(abs);
        const size = st?.size ?? 0;
        if (size > input.max_bytes)
          throw err.invalidInput("attachment exceeds max_bytes", {
            path: rel,
            size,
            max_bytes: input.max_bytes,
          });
        const content = readFileChecked(abs).toString("base64");
        return {
          vault: v.id,
          path: rel,
          mime: mimeOf(rel),
          size,
          encoding: "base64",
          content,
          // N-2: only reveal referencing notes the caller may read (findAttachmentReferences walks
          // the whole vault ACL-free), so this cannot enumerate out-of-ACL note paths.
          ...(input.include_references
            ? {
                references: findAttachmentReferences(v.root, rel).filter((p) =>
                  readableRel(ctx.acl, p, ctx.grantedScopes),
                ),
              }
            : {}),
        };
      },
    }),

    defineTool({
      name: "write_attachment",
      domain: "attachments",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      // A bare filename resolves against the vault's attachment folder, which only the root can say;
      // env.root is absent outside dispatch, where the input-only answer is all there is.
      pathAcl: (input, env) => [
        {
          op: "write",
          path: env ? resolveAttachmentWritePath(env.root, input.path) : input.path,
        },
      ],
      description:
        "Write a binary attachment (image, PDF, audio, video) into the vault from base64 content. A bare filename goes to the vault's attachment folder; a path with a folder is used as given. Refuses existing files unless overwrite is set, which requires confirmation and soft-deletes the prior bytes to .trash. Capped by writes.maxAttachmentBytes (default 25 MB decoded).",
      inputSchema: WriteInput,
      outputSchema: WriteAttachmentOutput,
      requiredScopes: ["write:attachments"],
      // Display-only — see ToolDefinition.conditionallyDestructive. The real gate is the
      // requireConfirmation call below (replacing an existing file).
      conditionallyDestructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = resolveAttachmentWritePath(v.root, input.path);
        const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")).toLowerCase() : "";
        if (OWN_TOOL_EXTS.has(ext))
          throw err.invalidInput(
            "notes, canvases and bases have their own tools (write_note, create_canvas, create_base); write_attachment is for binary attachments",
            { path: rel },
          );
        if (!isAttachment(rel))
          throw err.invalidInput("path is not an attachment (extension not in the allowlist)", {
            path: rel,
            extensions: DEFAULT_ATTACHMENT_EXTS,
          });
        // enforcePathAcl covers this too, but only when an ACL is present; a control directory is
        // never an attachment destination, ACL or not.
        if (isDefaultDenied(rel))
          throw err.aclDenied("path is in a protected vault directory", {
            path: redactSecrets(rel).text,
            op: "write",
          });
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const abs = resolveVaultPath(v.root, rel);
        // The write is a rename onto `abs`, which would replace a symlink rather than follow it —
        // but an alias the caller can see through is not an attachment path they meant to write.
        try {
          if (lstatSync(abs).isSymbolicLink())
            throw err.pathInvalid("refusing to write through a symlink", { path: rel });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const mime = mimeOf(rel);
        if (input.mime_type !== undefined && input.mime_type.toLowerCase() !== mime)
          throw err.invalidInput("mime_type does not match the path's extension", {
            path: rel,
            mime_type: input.mime_type,
            expected: mime,
          });
        const maxBytes = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
        const size = checkBase64Payload(input.content, maxBytes);
        // Binary bytes are not scanned (there is no text to scan), but the path lands in the vault
        // and is refused if secret-shaped, same as every other writer.
        enforceMemoryDefenseOnNoteWrite(deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF, rel, "", {
          metrics: deps.metrics,
        });

        const ex = noteExists(abs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: rel });
        if (ex.exists && !input.overwrite)
          throw err.noteExists("attachment already exists; set overwrite", { path: rel });
        const replacing = ex.exists;
        requireConfirmation(ctx, "write_attachment", input, replacing, {
          path: rel,
          size,
          previous_size: replacing ? (statNote(abs)?.size ?? null) : null,
        });

        const bytes = Buffer.from(input.content, "base64");
        // Trash + write is two steps, so the retry after a failed write must not read as a clean
        // "nothing happened" (THE-572, as in move_attachment).
        ctx.markEffectCommitted?.();
        const trashedPrevTo = replacing ? trashNote(v.root, rel) : null;
        try {
          writeFileAtomic(abs, bytes, input.options.create_dirs);
        } catch (e) {
          // Put the prior bytes back rather than leave the path empty with the file in .trash.
          if (trashedPrevTo) renameSync(join(v.root, trashedPrevTo), abs);
          throw e;
        }
        return {
          vault: v.id,
          path: rel,
          created: !replacing,
          overwritten: replacing,
          size: bytes.length,
          mime,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          trashed_prev_to: trashedPrevTo,
        };
      },
    }),

    defineTool({
      name: "move_attachment",
      domain: "attachments",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      // Reference rewrites in linking notes are the deliberate cross-ACL carve-out (N-3, THE-303),
      // enforced handler-side; the ACL-gated paths are the attachment source (delete) + dest (write).
      pathAcl: (input) => [
        { op: "delete", path: input.from },
        { op: "write", path: input.to },
      ],
      description:
        "Move/rename an attachment and repoint note links to it (link style preserved). Crossing a folder boundary or overwriting requires confirmation.",
      inputSchema: MoveInput,
      outputSchema: MoveAttachmentOutput,
      requiredScopes: ["write:attachments", "delete:attachments"],
      // THE-824: display-only — see ToolDefinition.conditionallyDestructive. The real gate stays
      // the requireConfirmation call below (crossFolder || overwriteExisting); this only stops the
      // wire annotation from advertising destructive: false for a tool that CAN demand confirmation.
      conditionallyDestructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const fromRel = normalizeVaultPath(input.from);
        const toRel = normalizeVaultPath(input.to);
        if (fromRel === toRel)
          throw err.invalidInput("from and to are identical", { path: fromRel });
        const fromAbs = resolveVaultPath(v.root, fromRel);
        const toAbs = resolveVaultPath(v.root, toRel);
        enforcePathAcl(ctx.acl, "delete", fromRel, v.root, ctx.grantedScopes);
        enforcePathAcl(ctx.acl, "write", toRel, v.root, ctx.grantedScopes);

        const fromEx = noteExists(fromAbs);
        if (!fromEx.exists || fromEx.type === "folder")
          throw err.noteNotFound("source attachment not found", { path: fromRel });
        const toEx = noteExists(toAbs);
        if (toEx.exists && toEx.type === "folder")
          throw err.invalidInput("destination is a folder", { path: toRel });
        if (toEx.exists && !input.overwrite)
          throw err.noteExists("destination already exists; set overwrite", { path: toRel });

        const crossFolder = dirOf(fromRel) !== dirOf(toRel);
        const overwriteExisting = toEx.exists && input.overwrite;
        requireConfirmation(ctx, "move_attachment", input, crossFolder || overwriteExisting, {
          from: fromRel,
          to: toRel,
          overwrite: overwriteExisting,
        });

        // THE-572: copy + hardDelete + rewriteAttachmentReferences is multi-step, and the reference
        // rewrite at the end is fallible. A throw there released the claim, and the retry found the
        // source already gone and reported not-found rather than the accurate "may have applied".
        ctx.markEffectCommitted?.();
        // On overwrite, soft-delete the destination first so its prior bytes are recoverable.
        let trashedDestTo: string | null = null;
        if (overwriteExisting) trashedDestTo = trashNote(v.root, toRel);
        if (input.options.create_dirs) mkdirSync(dirname(toAbs), { recursive: true });
        copyFileSync(fromAbs, toAbs);
        hardDelete(fromAbs);
        // the rewritten link text lands in referencing notes' bodies — same guard every
        // other note-content writer gets (see rewriteAttachmentReferences's own doc comment).
        const mdConfig = deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF;
        const references = input.update_references
          ? rewriteAttachmentReferences(v.root, fromRel, toRel, mdConfig, deps.metrics)
          : { notes: 0, refs: 0 };
        return {
          vault: v.id,
          from: fromRel,
          to: toRel,
          moved: true,
          overwritten: toEx.exists,
          trashed_dest_to: trashedDestTo,
          references_updated: references,
        };
      },
    }),

    defineTool({
      name: "delete_attachment",
      domain: "attachments",
      vaultArg: "vault",
      pathAcl: (input) => [{ op: "delete", path: input.path }],
      description:
        "Delete an attachment (to the vault's .trash mirror, or permanently). Destructive — requires confirmation. Reports notes that still reference it.",
      inputSchema: DeleteInput,
      outputSchema: DeleteAttachmentOutput,
      requiredScopes: ["delete:attachments"],
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "delete", rel, v.root, ctx.grantedScopes);
        const abs = resolveVaultPath(v.root, rel);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("attachment not found", { path: rel });
        const references = findAttachmentReferences(v.root, rel).filter((p) =>
          readableRel(ctx.acl, p, ctx.grantedScopes),
        );
        const st = statNote(abs);
        let trashedTo: string | null = null;
        if (input.permanent) hardDelete(abs);
        else trashedTo = trashNote(v.root, rel);
        return {
          vault: v.id,
          path: rel,
          deleted: true,
          permanent: input.permanent,
          trashed_to: trashedTo,
          size: st?.size ?? null,
          references,
        };
      },
    }),
  ];
}
