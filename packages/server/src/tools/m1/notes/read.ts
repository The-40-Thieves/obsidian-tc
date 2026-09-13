// WP8: notes-tools.ts split. read_note (single, full detail) and read_notes (batch, partial —
// returns successful notes plus a per-path error list) — extracted verbatim out of
// buildNotesTools. Both are read-only, both funnel through resolveVaultPath + enforcePathAcl.
//
// THE-1038 / GH #927: read_note's optional `anchor` reuses patch_note's resolveSection (see
// notes/anchors.ts) so a caller can read exactly the section it is about to patch, instead of the
// whole note.
import { err, ObsidianTcError, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { parseNote } from "../../../vault/frontmatter";
import { noteExists, readNote, statNote } from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { resolveSectionOrThrow } from "./anchors";
import { PatchAnchor, ReadNoteOutput, ReadNotesOutput } from "./schemas";

/** Number of raw-file lines preceding `parsed.body`'s line 0 — the frontmatter delimiter pair
 *  plus its YAML line count (0 when the note has no frontmatter). Used to translate a
 *  resolveSection span (body-relative) into read_note's raw-file line numbers.
 *
 *  Review round 1 C1(b): NO special case for an empty `rawFrontmatter` — parseNote's frontmatter
 *  regex requires an actual `\n` between the two `---` delimiters to capture `""`, so an empty
 *  capture still means one real (blank) YAML line occupying a raw line (`---\n\n---\n` is 3 raw
 *  lines); `"".split(/\r?\n/).length` is 1, which is correct here, not a value to override to 0. */
function frontmatterLineOffset(rawFrontmatter: string | null): number {
  if (rawFrontmatter === null) return 0;
  return rawFrontmatter.split(/\r?\n/).length + 2; // + the opening and closing "---" lines
}

export function createReadNoteTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "read_note",
    domain: "notes",
    pathAcl: (input) => [{ op: "read", path: input.path }],
    description:
      "Read a note's raw content, parsed frontmatter, body, content hash, and stat. With anchor (same shape as patch_note's: a heading section, a block reference, or the frontmatter preamble), also returns section: the resolved span's text (including its heading/block-id marker line), 1-based start_line/end_line relative to the raw file, and heading_level for a heading anchor. content_hash stays the whole-note hash so it round-trips into patch_note's prev_hash unchanged.",
    inputSchema: z
      .object({ vault: VaultId, path: VaultPath, anchor: PatchAnchor.optional() })
      .strict(),
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
      const parsed = parseNote(raw, rel);
      let section: z.infer<typeof ReadNoteOutput>["section"];
      if (input.anchor) {
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const resolved = resolveSectionOrThrow(parsed.body, input.anchor, rel);
        const bodyLines = parsed.body.split(/\r?\n/);
        const offset = frontmatterLineOffset(parsed.rawFrontmatter);
        // Review round 1 C1(c): a trailing line terminator makes split()'s last element a
        // phantom "line" (the position after the final terminator, not real content) — a section
        // whose endIndex reaches it (an unbounded section running to EOF) must not report that
        // phantom as a real end_line, or count it in `text`.
        const hasTrailingPhantom =
          bodyLines.length > 0 &&
          bodyLines[bodyLines.length - 1] === "" &&
          /\r?\n$/.test(parsed.body);
        const realLineCount = hasTrailingPhantom ? bodyLines.length - 1 : bodyLines.length;
        const endIndex = Math.min(resolved.endIndex, realLineCount);
        const isEmpty = resolved.startIndex === resolved.endIndex;
        section = {
          text: bodyLines.slice(resolved.startIndex, endIndex).join(eol),
          start_line: resolved.startIndex + 1 + offset,
          // C1(a): an empty section (only the frontmatter/preamble anchor can be zero-length)
          // reports start_line === end_line rather than end_line = start_line - 1 — see
          // ReadNoteSectionOut's doc comment for why.
          end_line: isEmpty ? resolved.startIndex + 1 + offset : endIndex + offset,
          ...(resolved.headingLevel !== undefined ? { heading_level: resolved.headingLevel } : {}),
        };
      }
      return {
        vault: v.id,
        path: rel,
        content: raw,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        has_frontmatter: parsed.hasFrontmatter,
        content_hash: hash,
        stat: statNote(abs),
        ...(section ? { section } : {}),
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
          const parsed = parseNote(raw, rel);
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
