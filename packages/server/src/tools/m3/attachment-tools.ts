// Domain 9 — Attachments. Four tools: list_attachments, get_attachment,
// move_attachment, delete_attachment. Attachments are ordinary binary vault files
// (images, PDFs, audio, video) addressed by vault-relative path, so every handler
// funnels through resolveVaultPath (containment) + enforcePathAcl (whitelist) like
// notes. get_attachment returns bytes base64-encoded under a size cap. move_attachment
// repoints note links to the moved file (reference-style preserved) and confirms only
// when crossing a folder boundary or overwriting; delete_attachment is destructive
// (dispatch-gated HITL) and soft-deletes to .trash unless permanent, reporting the
// notes that still reference it so the caller can see what it is about to break.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
  err,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import {
  DEFAULT_ATTACHMENT_EXTS,
  findAttachmentReferences,
  mimeOf,
  resolveAttachmentFolder,
  rewriteAttachmentReferences,
} from "../../formats/attachments";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { hardDelete, noteExists, statNote, trashNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

function readable(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl || acl.readPaths === undefined) return true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

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

const MoveInput = z
  .object({
    vault: VaultId,
    from: VaultPath,
    to: VaultPath,
    overwrite: z.boolean().default(false),
    update_references: z.boolean().default(true),
    options: WriteOptions.default({}),
  })
  .strict();

const DeleteInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    permanent: z.boolean().default(false),
  })
  .strict();

export function buildAttachmentTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_attachments",
      description:
        "List attachment files in the vault (filtered by extension, read-ACL aware), with cursor pagination. Optionally count referencing notes per file.",
      inputSchema: ListInput,
      requiredScopes: ["read:attachments"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        if (sub) enforcePathAcl(ctx.acl, "read", sub);
        const exts = (input.extensions ?? DEFAULT_ATTACHMENT_EXTS).map((x) => x.toLowerCase());
        const entries = walkVault(v.root, { sub, recursive: true, extensions: exts }).filter((e) =>
          readable(ctx.acl, e.relPath),
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
              ? { reference_count: findAttachmentReferences(v.root, e.relPath).length }
              : {}),
          })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),

    defineTool({
      name: "get_attachment",
      description:
        "Read an attachment's bytes (base64) plus MIME type and size. Fails with invalid_input when the file exceeds max_bytes.",
      inputSchema: GetInput,
      requiredScopes: ["read:attachments"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel);
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
        const content = readFileSync(abs).toString("base64");
        return {
          vault: v.id,
          path: rel,
          mime: mimeOf(rel),
          size,
          encoding: "base64",
          content,
          ...(input.include_references
            ? { references: findAttachmentReferences(v.root, rel) }
            : {}),
        };
      },
    }),

    defineTool({
      name: "move_attachment",
      description:
        "Move/rename an attachment and repoint note links to it (link style preserved). Crossing a folder boundary or overwriting requires confirmation.",
      inputSchema: MoveInput,
      requiredScopes: ["write:attachments", "delete:attachments"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const fromRel = normalizeVaultPath(input.from);
        const toRel = normalizeVaultPath(input.to);
        if (fromRel === toRel)
          throw err.invalidInput("from and to are identical", { path: fromRel });
        const fromAbs = resolveVaultPath(v.root, fromRel);
        const toAbs = resolveVaultPath(v.root, toRel);
        enforcePathAcl(ctx.acl, "delete", fromRel);
        enforcePathAcl(ctx.acl, "write", toRel);

        const fromEx = noteExists(fromAbs);
        if (!fromEx.exists || fromEx.type === "folder")
          throw err.noteNotFound("source attachment not found", { path: fromRel });
        const toEx = noteExists(toAbs);
        if (toEx.exists && toEx.type === "folder")
          throw err.invalidInput("destination is a folder", { path: toRel });
        if (toEx.exists && !input.overwrite)
          throw err.noteExists("destination already exists; set overwrite", { path: toRel });

        const crossFolder = dirOf(fromRel) !== dirOf(toRel);
        requireConfirmation(
          ctx,
          "move_attachment",
          input,
          crossFolder || (toEx.exists && input.overwrite),
          { from: fromRel, to: toRel },
        );

        if (input.options.create_dirs) mkdirSync(dirname(toAbs), { recursive: true });
        copyFileSync(fromAbs, toAbs);
        hardDelete(fromAbs);
        const references = input.update_references
          ? rewriteAttachmentReferences(v.root, fromRel, toRel)
          : { notes: 0, refs: 0 };
        return {
          vault: v.id,
          from: fromRel,
          to: toRel,
          moved: true,
          overwritten: toEx.exists,
          references_updated: references,
        };
      },
    }),

    defineTool({
      name: "delete_attachment",
      description:
        "Delete an attachment (to the vault's .trash mirror, or permanently). Destructive — requires confirmation. Reports notes that still reference it.",
      inputSchema: DeleteInput,
      requiredScopes: ["delete:attachments"],
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "delete", rel);
        const abs = resolveVaultPath(v.root, rel);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("attachment not found", { path: rel });
        const references = findAttachmentReferences(v.root, rel);
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
