// Counts the notes a whole-vault walk skipped because the safe open refused their read (acl_denied).
// Only the count leaves the call: a refused note is one the caller may not read, so no path is named.
import { z } from "zod";
import { readNoteOrRefusal } from "../vault/read-refusal";

/** Spread into a walking tool's output schema. The key is absent when no note was refused. */
export const readRefusalShape = {
  notes_read_refused: z.number().int().optional(),
};

export class ReadRefusals {
  // Keyed by note, so a note read by several walks of one call (one per attachment) counts once.
  private readonly refused = new Set<string>();

  /** The note's raw text, or null when the safe open refused it (counted). Any other error propagates. */
  read(root: string, rel: string): string | null {
    const r = readNoteOrRefusal(root, rel);
    if ("refused" in r) {
      this.refused.add(rel);
      return null;
    }
    return r.raw;
  }

  get count(): number {
    return this.refused.size;
  }

  /** Spread into the tool's return value (absent when nothing was refused). */
  out(): { notes_read_refused?: number } {
    return this.refused.size > 0 ? { notes_read_refused: this.refused.size } : {};
  }
}
