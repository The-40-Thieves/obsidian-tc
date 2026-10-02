// WP8: notes-tools.ts split. read_note (single, full detail) and read_notes (batch, partial —
// returns successful notes plus a per-path error list) — extracted verbatim out of
// buildNotesTools. Both are read-only, both funnel through resolveVaultPath + enforcePathAcl.
//
// THE-1038 / GH #927: read_note's optional `anchor` reuses patch_note's resolveSection (see
// notes/anchors.ts) so a caller can read exactly the section it is about to patch, instead of the
// whole note.
import { err, ObsidianTcError, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../../acl";
import { paginateByBytes, pagingOf } from "../../../mcp/byte-page";
import type { ToolDefinition } from "../../../mcp/registry";
import { enforcePathAcl } from "../../../vault/acl-path";
import { type LenientParsedNote, parseNoteLenient } from "../../../vault/frontmatter";
import { noteExists, readNote, statNote } from "../../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import { ResponseFormatInput, resolveResponseFormat } from "../../response-format";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { resolveSectionOrThrow } from "./anchors";
import { PatchAnchor, ReadNoteOutput, ReadNotesOutput } from "./schemas";

/** What a read returns for a note whose frontmatter is not valid YAML: the raw frontmatter text,
 *  the parse error's location, and the repair route. Empty for a note that parsed. */
export function unparseableFrontmatterFields(parsed: LenientParsedNote): {
  raw_frontmatter?: string;
  frontmatter_error?: { message: string; line?: number; column?: number };
  warning?: string;
} {
  const e = parsed.yamlError;
  if (!e) return {};
  const { line, column } = (e.details ?? {}) as { line?: number; column?: number };
  return {
    raw_frontmatter: parsed.rawFrontmatter ?? "",
    frontmatter_error: {
      message: e.message,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    },
    warning:
      "frontmatter is not valid YAML, so it is returned as null and raw_frontmatter holds its text. " +
      'Repair it with update_frontmatter {operation: "replace", frontmatter_yaml: <corrected YAML>, ' +
      "prev_hash: <content_hash>}; it needs no approval because there is no parsed metadata to discard.",
  };
}

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
      "Read a note's raw content, parsed frontmatter, body, content hash, and stat. With anchor (same shape as patch_note's: a heading section, a block reference, or the frontmatter preamble), also returns section: the resolved span's text (including its heading/block-id marker line), 1-based start_line/end_line relative to the raw file, and heading_level for a heading anchor. content_hash stays the whole-note hash so it round-trips into patch_note's prev_hash unchanged. A note whose frontmatter is not valid YAML is still returned (frontmatter null) with raw_frontmatter, frontmatter_error {message, line, column} and a warning naming the repair (update_frontmatter replace with frontmatter_yaml). response_format=concise returns {vault, path, body, content_hash}: the note body without its frontmatter block (and, with an anchor, the section instead of the whole body).",
    inputSchema: z
      .object({
        vault: VaultId,
        path: VaultPath,
        anchor: PatchAnchor.optional(),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: ReadNoteOutput,
    requiredScopes: ["read:notes"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const rel = normalizeVaultPath(input.path);
      const abs = resolveVaultPath(v.root, rel);
      enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
      const ex = noteExists(abs);
      if (!ex.exists || ex.type === "folder")
        throw err.noteNotFound("note not found", { vault: v.id, path: rel });
      const { raw, hash } = readNote(abs);
      const parsed = parseNoteLenient(raw, rel);
      const unparseable = unparseableFrontmatterFields(parsed);
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
      // GH #1027: a concise read is the body without its frontmatter block, or just the section when
      // an anchor asked for one (the caller already chose what it wants; the rest of the note would
      // be re-read on every later turn). content_hash stays the whole-note hash either way.
      if (resolveResponseFormat(input, deps.responseFormat) === "concise")
        return {
          vault: v.id,
          path: rel,
          ...(section ? { section } : { body: parsed.body }),
          content_hash: hash,
          ...unparseable,
        };
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
        ...unparseable,
      };
    },
  });
}

/** The per-note read path shared by read_notes and search_and_read: containment guard, folder ACL
 *  (plus the path's rule-scopes), existence (a folder answers like a
 *  missing note), then read + parse. Throws an ObsidianTcError; the caller shapes it into an item. */
export function readVaultNote(
  root: string,
  rel: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
) {
  const abs = resolveVaultPath(root, rel);
  enforcePathAcl(acl, "read", rel, root, grantedScopes);
  const ex = noteExists(abs);
  if (!ex.exists || ex.type === "folder") throw err.noteNotFound("note not found", { path: rel });
  const { raw, hash } = readNote(abs);
  return { raw, hash, parsed: parseNoteLenient(raw, rel) };
}

/** One read_notes item: a note entry, or a per-path error entry (partial semantics). */
type ReadNotesEntryOrError =
  | { kind: "note"; note: Record<string, unknown> }
  | { kind: "error"; error: Record<string, unknown> };

export function createReadNotesTool(deps: M1Deps): ToolDefinition {
  return defineTool({
    name: "read_notes",
    domain: "notes",
    pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
    description:
      "Batch-read notes. Returns successful notes and a per-path error list (partial). The response is held under the server's byte budget: when the batch does not fit, the notes that fit are returned with next_cursor; call again with the same arguments plus cursor to continue exactly where the page stopped (request order, no duplicates, no gaps) until next_cursor is null. A single note too large to ever fit is reported as a too_large error (with its size and the budget) and skipped, so the walk always makes progress. A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns each note as {path, body, content_hash} (no raw content, no frontmatter); per-path errors are unchanged.",
    inputSchema: z
      .object({
        vault: VaultId,
        paths: z.array(VaultPath).min(1).max(100),
        cursor: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("The next_cursor of a previous page of this same request."),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: ReadNotesOutput,
    requiredScopes: ["read:notes"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
      const { entries, nextCursor } = await paginateByBytes<string, ReadNotesEntryOrError>({
        paging: pagingOf(deps.paging),
        binding: { tool: "read_notes", principal: ctx.caller, args: input },
        cursor: input.cursor,
        items: input.paths,
        // Runs per item on every page, so a folder ACL revoked between pages is honoured on resume.
        produce: (p) => {
          try {
            const rel = normalizeVaultPath(p);
            const { raw, hash, parsed } = readVaultNote(v.root, rel, ctx.acl, ctx.grantedScopes);
            return {
              kind: "note",
              note: concise
                ? {
                    path: rel,
                    body: parsed.body,
                    content_hash: hash,
                    ...unparseableFrontmatterFields(parsed),
                  }
                : {
                    path: rel,
                    content: raw,
                    frontmatter: parsed.frontmatter,
                    body: parsed.body,
                    content_hash: hash,
                    ...unparseableFrontmatterFields(parsed),
                  },
            };
          } catch (e) {
            const code = e instanceof ObsidianTcError ? e.code : "internal_error";
            return { kind: "error", error: { path: p, code, message: (e as Error).message } };
          }
        },
        tooLarge: (p, { size, budget }) => ({
          kind: "error",
          error: {
            path: p,
            code: "too_large",
            message: "note is larger than the response byte budget and cannot be returned",
            size,
            budget,
          },
        }),
        frame: (es, next) => readNotesResult(v.id, es, next),
        lane: (e) => e.kind,
        wire: (e) => (e.kind === "note" ? e.note : e.error),
      });
      return readNotesResult(v.id, entries, nextCursor);
    },
  });
}

function readNotesResult(
  vault: string,
  entries: ReadNotesEntryOrError[],
  nextCursor: string | null,
) {
  const notes: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    if (e.kind === "note") notes.push(e.note);
    else errors.push(e.error);
  }
  return { vault, notes, errors, next_cursor: nextCursor };
}
