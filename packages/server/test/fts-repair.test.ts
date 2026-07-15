import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ensureNotesFts, upsertNoteRow } from "../src/search/fts";
import { openMemoryDb } from "./helpers";

const _SRC = fileURLToPath(new URL("../src", import.meta.url));
const FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(vault_id UNINDEXED, path, title, content, tokenize='trigram')";

/** A fresh connection each time — ensureNotesFts memoizes per Database, so reuse would hide the repair. */
function dbWithNotes(): any {
  const db = openMemoryDb();
  provisionCacheDb(db); // the same chain production runs — no bespoke fixture schema
  return db;
}

const rec = (p: string) => ({
  path: p,
  title: p,
  tagsJson: "[]",
  frontmatterJson: "{}",
  contentHash: "hash-1",
  mtime: 1,
  size: 1,
  ftsContent: "body text",
});

const count = (db: any, sql: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;

describe("notes/notes_fts divergence repair", () => {
  beforeEach(() => {
    process.env.OBSIDIAN_TC_DISABLE_FTS = "";
  });

  it("does NOT delete note rows when the FTS index is empty — it marks them stale instead", () => {
    const db = dbWithNotes();
    // Exactly the state a prior OBSIDIAN_TC_DISABLE_FTS=1 run leaves behind: notes written, FTS not.
    for (let i = 0; i < 20; i++) upsertNoteRow(db, "main", rec(`n${i}.md`), false, 1);
    expect(count(db, "notes")).toBe(20);

    expect(ensureNotesFts(db)).toBe(true); // provisions an EMPTY notes_fts, then repairs

    expect(count(db, "notes")).toBe(20); // the durable table survives. Before the fix: 0.
    // Every survivor is marked stale, so the next index pass re-reads it from disk and repopulates the
    // FTS index via the existing backfill path. FTS content cannot be reconstructed from `notes` (which
    // stores content_hash, not the body), so staleness — not deletion — is the way to force the rebuild.
    expect(count(db, "notes WHERE content_hash = ''")).toBe(20);
    db.close();
  });

  it("still prunes FTS orphans — the DERIVED index is the one that may be deleted", () => {
    const db = dbWithNotes();
    db.exec(FTS_DDL); // pre-provision so we can seed an orphan before the first ensureNotesFts call
    upsertNoteRow(db, "main", rec("kept.md"), true, 1); // note + its FTS row
    db.prepare(
      "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('main', 'ghost.md', 't', 'c')",
    ).run(); // an FTS row whose note is gone
    expect(count(db, "notes_fts")).toBe(2);

    ensureNotesFts(db);

    expect(count(db, "notes_fts")).toBe(1); // the orphan is pruned
    expect(count(db, "notes")).toBe(1); // the real note is untouched
    expect(count(db, "notes WHERE content_hash = ''")).toBe(0); // and NOT marked stale — it has its FTS row
    db.close();
  });
});
