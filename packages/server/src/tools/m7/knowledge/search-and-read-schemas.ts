import { z } from "zod";

/** search_and_read. `notes` holds one entry per note (mode "note") or per matched section (mode
 *  "section"); `errors` one per item that could not be returned. A denied item is reported exactly
 *  as a missing one (no path), so the errors lane cannot be used to probe for a hidden note. */
export const SearchAndReadNote = z.object({
  path: z.string(),
  rank: z.number().int().positive(),
  score: z.number(),
  /** Section mode: the matched chunk, its heading (null = before the first heading) and whether
   *  that heading resolved to a unique section in the current note (false = `body` is the chunk). */
  chunk_id: z.string().optional(),
  heading: z.string().nullable().optional(),
  section_resolved: z.boolean().optional(),
  /** Note mode only: parsed frontmatter, as read_notes returns it. */
  frontmatter: z.record(z.string(), z.unknown()).nullable().optional(),
  body: z.string(),
  /** Hash of the WHOLE note, so it round-trips into patch_note's prev_hash in either mode. */
  content_hash: z.string(),
  /** UTF-8 bytes of `body` before any cut. GH #1027: response_format=concise keeps it only on a
   *  truncated item, where it is the full size to fetch whole; absent otherwise. */
  size_bytes: z.number().int().nonnegative().optional(),
  /** GH #1027: concise omits it when false (absent means not truncated). */
  truncated: z.boolean().optional(),
});

export const SearchAndReadError = z.object({
  rank: z.number().int().positive(),
  path: z.string().optional(),
  code: z.string(),
  message: z.string(),
  size: z.number().optional(),
  budget: z.number().optional(),
});

export const SearchAndReadOutput = z.object({
  vault: z.string(),
  mode: z.enum(["note", "section"]),
  notes: z.array(SearchAndReadNote),
  errors: z.array(SearchAndReadError),
  next_cursor: z.string().nullable(),
});
