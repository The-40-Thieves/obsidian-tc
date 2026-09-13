// WP8: notes-tools.ts split. Every input/output Zod schema for the 10 M1 note-CRUD tools, moved
// here verbatim from the top of the pre-split file. THE-417 Phase 1 note preserved: each output
// schema is written from its handler's RETURN STATEMENTS, not from the io/frontmatter types the
// data is built from (parseNote/statNote/captureSnapshot etc. get renamed, derived, or
// conditionally spread on the way out). Conditional spreads (`...(cond ? { x } : {})`) are
// `.optional()`, never `.nullable()`.
import {
  ElicitToken,
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";

// ── output schemas ───────────────────────────────────────────────────────────

/** Mirrors vault/frontmatter.ts's ParsedNote.frontmatter: null when the note has no `---` block,
 *  otherwise the parsed YAML mapping (shape genuinely unknown per key). */
export const FrontmatterOut = z.record(z.string(), z.unknown()).nullable();

/** Mirrors vault/notes-io.ts's NoteStat; null when statNote's statSync throws (e.g. the file
 *  vanished between the existence check and the stat — a race, not a validation failure). */
export const NoteStatOut = z
  .object({ size: z.number(), mtime: z.string(), ctime: z.string() })
  .nullable();

/** THE-1038 / GH #927: the span `resolveSection` (notes/anchors.ts) resolved when `read_note` is
 *  called with an `anchor`. `text` includes the section's own marker line — the heading line for
 *  a heading anchor, or the block paragraph including its `^id` line — matching what a `replace`
 *  on the same anchor would discard. `start_line`/`end_line` are 1-based and inclusive, relative
 *  to the raw file `content` (frontmatter lines counted in). `heading_level` is present only for
 *  a heading anchor. */
export const ReadNoteSectionOut = z.object({
  text: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  heading_level: z.number().optional(),
});

export const ReadNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  content: z.string(),
  frontmatter: FrontmatterOut,
  body: z.string(),
  has_frontmatter: z.boolean(),
  content_hash: z.string(),
  stat: NoteStatOut,
  // Omitted (not null) when the caller passed no `anchor` — see ReadNoteSectionOut.
  section: ReadNoteSectionOut.optional(),
});

/** read_notes' per-note entry is hand-assembled in the loop below and is NARROWER than
 *  ReadNoteOutput — no has_frontmatter, no stat. */
export const ReadNotesEntry = z.object({
  path: z.string(),
  content: z.string(),
  frontmatter: FrontmatterOut,
  body: z.string(),
  content_hash: z.string(),
});

export const ReadNotesError = z.object({ path: z.string(), code: z.string(), message: z.string() });

export const ReadNotesOutput = z.object({
  vault: z.string(),
  notes: z.array(ReadNotesEntry),
  errors: z.array(ReadNotesError),
});

export const ListNotesOutput = z.object({
  vault: z.string(),
  folder: z.string(),
  notes: z.array(z.object({ path: z.string(), size: z.number(), mtime: z.number() })),
  next_cursor: z.string().nullable(),
  total_returned: z.number(),
});

export const NoteExistsOutput = z.object({
  vault: z.string(),
  path: z.string(),
  exists: z.boolean(),
  type: z.enum(["file", "folder"]).nullable(),
});

/** THE-643 item 1: the write-time guardrail. `null` means the note_quality rollup has never run
 *  for this (vault, path) — NOT a false all-clear, just nothing measured yet. `{flags: [], ...}`
 *  is the genuine clean case. Never recomputed on the write path — reflects whatever the last
 *  offline/scheduled `note-quality` pass last wrote. */
export const QualityWarningOut = z
  .object({ flags: z.array(z.string()), computed_at: z.number() })
  .nullable();

/** THE-639: assessPoison's verdict, surfaced only when `provenance: "agent_synthesis"` ran the
 *  scan; null on the (default) "authored" path where assessPoison never runs — same null-means-
 *  not-computed convention as QualityWarningOut, not a false all-clear. */
export const PoisonAssessmentOut = z
  .object({ risk: z.enum(["none", "suspect", "high"]), signals: z.array(z.string()) })
  .nullable();

export const WriteNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  created: z.boolean(),
  mode_used: z.enum(["create", "overwrite"]),
  content_hash: z.string(),
  prev_hash: z.string().nullable(),
  bytes_written: z.number(),
  quality_warning: QualityWarningOut,
  poison_assessment: PoisonAssessmentOut,
});

export const AppendNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  created: z.boolean(),
  content_hash: z.string(),
  prev_hash: z.string().nullable(),
  bytes_written: z.number(),
  quality_warning: QualityWarningOut,
  poison_assessment: PoisonAssessmentOut,
});

/** Mirrors the PatchAnchor input union verbatim — patch_note echoes the resolved anchor back. */
export const PatchAnchorOut = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), heading: z.string() }),
  z.object({ type: z.literal("block"), block_id: z.string() }),
  z.object({ type: z.literal("frontmatter") }),
]);

export const PatchNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  // THE-1038 / GH #928: replace_text — an exact-string substitution scoped to the resolved
  // anchor's section.
  operation: z.enum(["append", "prepend", "replace", "replace_text"]),
  anchor: PatchAnchorOut,
  // Present only when anchor.type === "heading" (legacy target_heading echo) — omitted, not
  // null, for the block/frontmatter arms.
  target_heading: z.string().optional(),
  content_hash: z.string(),
  // Not nullable: reached only after readNote() on a note whose existence was already confirmed.
  prev_hash: z.string(),
  // THE-603: the blast radius of this write. 0 for append/prepend, which only insert; a
  // catastrophic replace and a two-line replace used to return structurally identical payloads.
  // For replace_text: the line count and byte size of `old_string` (GH #928).
  lines_removed: z.number(),
  bytes_removed: z.number(),
  quality_warning: QualityWarningOut,
});

export const DeleteNoteOutput = z.object({
  vault: z.string(),
  path: z.string(),
  deleted: z.literal(true),
  permanent: z.boolean(),
  trashed_to: z.string().nullable(),
  // Not nullable: same reasoning as patch_note's prev_hash.
  prev_hash: z.string(),
});

export const MoveNoteOutput = z.object({
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  moved: z.literal(true),
  overwritten: z.boolean(),
  trashed_dest_to: z.string().nullable(),
  content_hash: z.string(),
  backlinks_updated: z.object({ notes: z.number(), links: z.number() }),
});

export const CopyNoteOutput = z.object({
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  copied: z.literal(true),
  overwritten: z.boolean(),
  trashed_dest_to: z.string().nullable(),
  content_hash: z.string(),
});

// ── input schemas ────────────────────────────────────────────────────────────

export const WriteMode = z.enum(["create", "overwrite", "upsert"]);

/** THE-639: who stands behind this content. "authored" (default) is a human/caller-vouched
 *  write — unchanged, byte-identical behavior for every existing caller that omits the field.
 *  "agent_synthesis" marks a derived/inferred conclusion an agent produced from retrieval; it
 *  routes through assessPoison before the write lands (see write.ts) and is a documented
 *  convention to also carry `source: agent-synthesis` in the note's own YAML frontmatter, so the
 *  existing frontmatter-JSON query path can filter these notes later. */
export const Provenance = z.enum(["authored", "agent_synthesis"]);

export const WriteInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    content: z.string(),
    mode: WriteMode.default("create"),
    prev_hash: z.string().optional(),
    options: WriteOptions.prefault({}),
    // THE-824: advertised so a caller can discover the HITL confirmation parameter via
    // describe_capability — stripped off rawArgs into ctx.elicitToken before this schema ever
    // validates it (mcp/server.ts), so declaring it here changes nothing about dispatch.
    elicit_token: ElicitToken.optional(),
    provenance: Provenance.default("authored"),
  })
  .strict();

export const AppendInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    content: z.string(),
    create_if_missing: z.boolean().default(false),
    ensure_newline: z.boolean().default(true),
    prev_hash: z.string().optional(),
    options: WriteOptions.prefault({}),
    provenance: Provenance.default("authored"),
  })
  .strict();

// THE-198: target a heading section, a block reference (^id), or the frontmatter preamble.
export const PatchAnchor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), heading: z.string().min(1) }).strict(),
  z.object({ type: z.literal("block"), block_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("frontmatter") }).strict(),
]);

export const PatchInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    operation: z.enum(["append", "prepend", "replace", "replace_text"]),
    // Legacy shorthand, equivalent to anchor:{type:"heading",heading}. Retained for back-compat.
    target_heading: z.string().min(1).optional(),
    anchor: PatchAnchor.optional(),
    // Required unless operation is replace_text (see the superRefine below).
    content: z.string().optional(),
    // THE-1038 / GH #928: replace_text's exact-string substitution, scoped to the resolved
    // anchor's section. Required (both fields) iff operation is replace_text.
    old_string: z.string().min(1).optional(),
    new_string: z.string().optional(),
    prev_hash: z.string().optional(),
    // THE-603: required (set true) only when operation:"replace" on a heading anchor would discard
    // more than 20 lines AND over half of the note's body — e.g. replacing a note's only H1, which
    // has no same-or-higher-level heading to bound it and so consumes the entire document below
    // it. Ignored for append/prepend, for block/frontmatter anchors (which cannot hit this), and
    // for replace_text (a bounded, uniqueness-checked substitution is not the operation this
    // guards against).
    confirm_replace: z.boolean().default(false),
  })
  .strict()
  .superRefine((i, ctx) => {
    if (i.anchor === undefined && i.target_heading === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "either anchor or target_heading is required",
      });
    if (i.operation === "replace_text") {
      if (i.old_string === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["old_string"],
          message: "old_string is required when operation is replace_text",
        });
      if (i.new_string === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["new_string"],
          message: "new_string is required when operation is replace_text",
        });
    } else if (i.content === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content is required unless operation is replace_text",
      });
    }
  });

export const MoveInput = z
  .object({
    vault: VaultId,
    from: VaultPath,
    to: VaultPath,
    overwrite: z.boolean().default(false),
    update_backlinks: z.boolean().default(true),
    prev_hash: z.string().optional(),
    options: WriteOptions.prefault({}),
    // THE-824: see WriteInput's elicit_token above.
    elicit_token: ElicitToken.optional(),
  })
  .strict();

export const CopyInput = z
  .object({
    vault: VaultId,
    from: VaultPath,
    to: VaultPath,
    overwrite: z.boolean().default(false),
    options: WriteOptions.prefault({}),
    // THE-824: see WriteInput's elicit_token above.
    elicit_token: ElicitToken.optional(),
  })
  .strict();

export const DeleteInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    permanent: z.boolean().default(false),
    prev_hash: z.string().optional(),
  })
  .strict();

export const ListInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    recursive: z.boolean().default(true),
    extensions: z.array(z.string().min(1)).optional(),
  })
  .merge(Pagination)
  .strict();
