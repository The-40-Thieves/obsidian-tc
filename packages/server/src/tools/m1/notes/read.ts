// WP8: notes-tools.ts split. read_note (single, full detail) and read_notes (batch, partial —
// returns successful notes plus a per-path error list) — extracted verbatim out of
// buildNotesTools. Both are read-only, both funnel through resolveVaultPath + enforcePathAcl.
import { err, ObsidianTcError, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { parseNote } from "../../../vault/frontmatter";
import { noteExists, readNote, statNote } from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { ReadNoteOutput, ReadNotesOutput } from "./schemas";

export function createReadNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
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
  });
}

export function createReadNotesTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "read_notes",
    domain: "notes",
    pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
    description: "Batch-read notes. Returns successful notes and a per-path error list (partial).",
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
  });
}
