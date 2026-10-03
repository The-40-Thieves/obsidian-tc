// Skip-and-warn for whole-vault scans. A tool that parses EVERY readable note must not fail for the
// whole vault because one note has frontmatter that is not valid YAML (the same policy the index
// reconcile applies): the note is read leniently (its frontmatter counts as absent, its body is
// still scanned) and named in the result's `warnings`, so the caller can repair it.
//
// Callers feed ScanWarnings only paths they already ACL-filtered for read, so a warning can never
// name a note the caller may not see. The link-scan code reads through `parse()`, which is also
// where the frontmatter-property link pass hooks in (`links()`).
import { z } from "zod";
import { type ParsedNote, parseNoteLenient } from "../vault/frontmatter";
import { type ExtractedLink, extractNoteLinks } from "../vault/links";

/** Warnings kept per result; the rest are only counted (`warnings_omitted`). */
export const MAX_SCAN_WARNINGS = 50;

export const ScanWarningSchema = z.object({
  path: z.string(),
  reason: z.literal("frontmatter_yaml"),
  message: z.string(),
});

type ScanWarning = z.infer<typeof ScanWarningSchema>;

/** Spread into a scanning tool's output schema. Both keys are absent when the scan was clean. */
export const scanWarningsShape = {
  warnings: z.array(ScanWarningSchema).optional(),
  warnings_omitted: z.number().int().optional(),
};

/** A property link a rewrite left alone because the new target could not be written back as valid
 *  YAML (vault/rewrite-properties.ts). The note's body links were still rewritten. */
export const RewriteWarningSchema = z.object({
  path: z.string(),
  property: z.string().optional(),
  message: z.string(),
});

export type RewriteWarning = z.infer<typeof RewriteWarningSchema>;

/** Spread into an output schema of a tool that rewrites links across notes. */
export const rewriteWarningsShape = {
  warnings: z.array(RewriteWarningSchema).optional(),
  warnings_omitted: z.number().int().optional(),
};

/** Spread into the output schema of a tool whose backlink/reference rewrite skips immutable notes
 *  (vault/acl-path.ts ImmutableRewriteSkips). All three keys are absent when nothing was skipped. */
export const immutableSkipShape = {
  immutable_not_updated: z.array(z.string()).optional(),
  immutable_not_updated_hidden: z.number().int().optional(),
  immutable_warning: z.string().optional(),
};

/** The `warnings` / `warnings_omitted` keys for a rewrite result (absent when there are none). */
export function rewriteWarningsOut(items: RewriteWarning[]): {
  warnings?: RewriteWarning[];
  warnings_omitted?: number;
} {
  return {
    ...(items.length > 0 ? { warnings: items.slice(0, MAX_SCAN_WARNINGS) } : {}),
    ...(items.length > MAX_SCAN_WARNINGS
      ? { warnings_omitted: items.length - MAX_SCAN_WARNINGS }
      : {}),
  };
}

export class ScanWarnings {
  private readonly items: ScanWarning[] = [];
  private omitted = 0;

  /** Parse one note of a scan. Never throws on bad frontmatter YAML: records a warning and returns
   *  the note with `frontmatter: null` and its real body. */
  parse(raw: string, path: string): ParsedNote {
    const { yamlError, ...parsed } = parseNoteLenient(raw, path);
    if (yamlError) this.add(path, yamlError.message);
    return parsed;
  }

  /** Every link of one note of a scan: property links (a note whose YAML failed has none), then
   *  body links, which always count. */
  links(raw: string, path: string): ExtractedLink[] {
    return extractNoteLinks(this.parse(raw, path));
  }

  private add(path: string, message: string): void {
    if (this.items.length >= MAX_SCAN_WARNINGS) this.omitted++;
    else this.items.push({ path, reason: "frontmatter_yaml", message });
  }

  /** Spread into the tool's return value. */
  out(): { warnings?: ScanWarning[]; warnings_omitted?: number } {
    return {
      ...(this.items.length > 0 ? { warnings: this.items } : {}),
      ...(this.omitted > 0 ? { warnings_omitted: this.omitted } : {}),
    };
  }
}
