// index_vault self-healing invariant.
//
// notes and chunks are written in SEPARATE transactions (THE-291: the notes/FTS pass is flushed
// independently so a broken embedding backend cannot block metadata readiness). The cost is a real,
// deliberate atomicity gap: a crash BETWEEN the two commits can leave a note whose `notes` row exists but
// whose `chunks` are missing, or the reverse. That is only benign because the next index_vault REPAIRS
// it — and it repairs it precisely because computeNotePlan diffs desired chunks against the `chunks`
// TABLE (an absent chunk set forces a re-embed) and the notes gate diffs against the stored note-row hash
// (a missing/stale row forces a rewrite).
//
// This test pins that invariant. If a future change makes chunk planning diff against a manifest stored
// in the `notes` row instead of the `chunks` table, case A below stops healing and the transient gap
// becomes PERMANENT corruption — a note forever invisible to dense/graph search. This test fails first.
import { describe, expect, it } from "vitest";
import { makeM2Vault } from "./m2-helpers";

const FILES = {
  "alpha.md": "# Alpha\n\nThe quick brown fox jumps over the lazy dog.",
  "beta.md": "# Beta\n\nPack my box with five dozen liquor jugs.",
};

const chunkCount = (v: any, path: string): number =>
  (
    v.db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
      .get(v.id, path) as { n: number }
  ).n;

const noteRowExists = (v: any, path: string): boolean =>
  (
    v.db
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = ? AND path = ?")
      .get(v.id, path) as { n: number }
  ).n > 0;

describe("index_vault self-heals the notes/chunks atomicity gap", () => {
  it("CASE A — notes row present, chunks lost (crash after flushNotes): next index re-chunks", async () => {
    const v = makeM2Vault({ files: FILES });
    try {
      await v.call("index_vault", { vault: v.id });
      const before = chunkCount(v, "alpha.md");
      expect(before).toBeGreaterThan(0);
      expect(noteRowExists(v, "alpha.md")).toBe(true);

      // The exact on-disk state a crash between the chunk COMMIT and... no — between flushNotes' COMMIT
      // and the chunk flush' COMMIT: the notes row is durable, the chunks never landed. Reproduce it by
      // dropping alpha's chunk rows while leaving its notes row.
      v.db.prepare("DELETE FROM chunks WHERE vault_id = ? AND path = ?").run(v.id, "alpha.md");
      expect(chunkCount(v, "alpha.md")).toBe(0); // inconsistent: metadata without chunks
      expect(noteRowExists(v, "alpha.md")).toBe(true);

      // The content on disk is UNCHANGED — the note-row hash still matches. A design that skipped
      // re-chunking on an unchanged note-row hash would leave alpha permanently invisible to search.
      await v.call("index_vault", { vault: v.id });

      expect(chunkCount(v, "alpha.md")).toBe(before); // healed: chunks are back
      expect(noteRowExists(v, "beta.md")).toBe(true); // the healthy note is untouched
    } finally {
      v.cleanup();
    }
  });

  it("CASE B — chunks present, notes row lost (crash before flushNotes): next index rewrites the row", async () => {
    const v = makeM2Vault({ files: FILES });
    try {
      await v.call("index_vault", { vault: v.id });
      expect(noteRowExists(v, "alpha.md")).toBe(true);
      const chunksBefore = chunkCount(v, "alpha.md");

      // Drop alpha's notes row (and its FTS shadow) while leaving its chunks: metadata-less, but still
      // dense-searchable.
      v.db.prepare("DELETE FROM notes WHERE vault_id = ? AND path = ?").run(v.id, "alpha.md");
      expect(noteRowExists(v, "alpha.md")).toBe(false);
      expect(chunkCount(v, "alpha.md")).toBe(chunksBefore); // chunks survive

      await v.call("index_vault", { vault: v.id });

      expect(noteRowExists(v, "alpha.md")).toBe(true); // healed: notes row is back
      expect(chunkCount(v, "alpha.md")).toBe(chunksBefore); // chunks were never disturbed
    } finally {
      v.cleanup();
    }
  });
});
