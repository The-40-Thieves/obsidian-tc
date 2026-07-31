// WP8: notes-tools.ts split. list_notes (folder listing, cursor-paginated, read-ACL filtered)
// and note_exists (existence + type check) — extracted verbatim out of buildNotesTools. Both are
// lightweight read-only lookups; list_notes is the only tool in this file whose ACL is enforced
// via a filter over walkVault results rather than a declared pathAcl extractor.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { noteExists } from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../../vault/paths";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { ListInput, ListNotesOutput, NoteExistsOutput } from "./schemas";

export function createListNotesTool(deps: M1Deps): ToolDefinition {
  return defineTool({
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
  });
}

export function createNoteExistsTool(deps: M1Deps): ToolDefinition {
  return defineTool({
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
  });
}
