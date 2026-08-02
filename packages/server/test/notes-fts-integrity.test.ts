// THE-696 — notes_fts integrity: exists vs SOUND.
//
// The live store carried a malformed notes_fts inverted index that still ANSWERED queries. It was
// found only because an unrelated `.backup` happened to run PRAGMA quick_check. Nothing inside the
// system could tell: ensureNotesFts provisions with CREATE VIRTUAL TABLE IF NOT EXISTS (a malformed
// table exists, so the guard returns true and never rebuilds) and health.fts_enabled reports
// availability. Measured on the live 252MB snapshot before writing this: five terms returned
// IDENTICAL counts from a healthy index and a deliberately corrupted one (363/587/144/257/545,
// delta 0 on every term), so result-eyeballing cannot detect this class of damage. Only the FTS5
// integrity-check can.
//
// The corruption here is REAL, not stubbed: `defensive: false` (node:sqlite DatabaseSync option,
// default true) permits the shadow-table write that produces genuine index damage. That matters —
// a stub throwing a chosen error would prove the classifier reads its own input, and would still
// pass if the integrity-check SQL itself were wrong.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureNotesFts, repairNotesFts, verifyNotesFtsIntegrity } from "../src/search/fts";

const FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(vault_id UNINDEXED, path, title, content, tokenize='trigram')";
const NOTES_DDL =
  "CREATE TABLE IF NOT EXISTS notes (vault_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, tags TEXT NOT NULL, frontmatter TEXT, content_hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL, PRIMARY KEY (vault_id, path))";
const MIGRATIONS_DDL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER, obsidian_tc_version TEXT, duration_ms INTEGER, checksum TEXT)";

/** A connection that PERMITS shadow-table writes, so the corruption below can be real.
 *  `any` matches the openMemoryDb helper: node:sqlite's `changes` is `number | bigint`, which the
 *  Database interface narrows to `number`. */
function openDefenselessDb(): any {
  const db = new DatabaseSync(":memory:", { defensive: false });
  db.exec(MIGRATIONS_DDL);
  db.exec(NOTES_DDL);
  return db;
}

/** A populated notes/notes_fts pair on such a connection. */
function dbWithPopulatedFts(): any {
  const db = openDefenselessDb();
  db.exec(FTS_DDL);
  for (let i = 0; i < 50; i++) {
    db.prepare(
      "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?,?,?,'[]',NULL,?,1,1,1)",
    ).run("main", `n${i}.md`, `t${i}`, `hash-${i}`);
    db.prepare("INSERT INTO notes_fts (vault_id, path, title, content) VALUES (?,?,?,?)").run(
      "main",
      `n${i}.md`,
      `t${i}`,
      `the quick brown fox ${i} obsidian decision memory vault`,
    );
  }
  return db;
}

/** Genuine inverted-index damage: clobber one notes_fts_data block. */
function corrupt(db: any): void {
  db.exec(
    "UPDATE notes_fts_data SET block = zeroblob(16) WHERE id = (SELECT max(id) FROM notes_fts_data)",
  );
}

describe("notes_fts integrity (THE-696)", () => {
  it("reports a healthy index as sound", () => {
    const db = dbWithPopulatedFts();
    // Non-vacuity in the POSITIVE direction: a mistyped or unsupported FTS5 command would throw
    // here and be misread as corruption, making every boot rebuild a perfectly good index.
    expect(verifyNotesFtsIntegrity(db)).toStrictEqual({ ok: true });
    db.close();
  });

  it("reports a genuinely malformed index as unsound, with a reason", () => {
    const db = dbWithPopulatedFts();
    corrupt(db);
    const result = verifyNotesFtsIntegrity(db);
    expect(result.ok).toBe(false);
    // The reason is the operator's only handle on what went wrong — an empty string would make the
    // doctor line read "MALFORMED — " and send nobody anywhere.
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    db.close();
  });

  it("reports an absent index as unsound rather than throwing", () => {
    const db = openDefenselessDb(); // notes present, notes_fts never provisioned
    // A diagnostic that dies while diagnosing is useless exactly when it is needed.
    expect(verifyNotesFtsIntegrity(db).ok).toBe(false);
    db.close();
  });

  it("repairs a malformed index back to sound", () => {
    const db = dbWithPopulatedFts();
    corrupt(db);
    expect(verifyNotesFtsIntegrity(db).ok).toBe(false); // watch it fail first

    expect(repairNotesFts(db)).toStrictEqual({ ok: true });

    expect(verifyNotesFtsIntegrity(db)).toStrictEqual({ ok: true });
    db.close();
  });

  it("preserves searchability across the repair", () => {
    const db = dbWithPopulatedFts();
    const before = db
      .prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'obsidian'")
      .get().n;
    corrupt(db);
    repairNotesFts(db);
    // `rebuild` reconstructs the index from the shadow content table, so nothing indexable is lost.
    // Asserting the count rather than merely "no throw": a rebuild that silently emptied the index
    // would pass integrity-check perfectly.
    expect(
      db.prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'obsidian'").get().n,
    ).toBe(before);
    expect(before).toBeGreaterThan(0);
    db.close();
  });
});

describe("ensureNotesFts integrity gate (THE-696)", () => {
  it("does NOT verify by default — a corrupt index still reports enabled", () => {
    const db = dbWithPopulatedFts();
    corrupt(db);
    process.env.OBSIDIAN_TC_DISABLE_FTS = "";
    delete process.env.OBSIDIAN_TC_VERIFY_FTS;

    // Deliberate: integrity-check costs ~0.6s on a 1,146-note vault and scales with corpus size,
    // so it is NOT paid on every boot. This test pins that cost decision — if verification becomes
    // unconditional, this fails and the change has to be argued rather than slipped in.
    expect(ensureNotesFts(db)).toBe(true);
    expect(verifyNotesFtsIntegrity(db).ok).toBe(false); // still corrupt: nothing rebuilt it

    db.close();
  });

  it("verifies and repairs when OBSIDIAN_TC_VERIFY_FTS=1", () => {
    const db = dbWithPopulatedFts();
    corrupt(db);
    process.env.OBSIDIAN_TC_DISABLE_FTS = "";
    process.env.OBSIDIAN_TC_VERIFY_FTS = "1";

    try {
      expect(ensureNotesFts(db)).toBe(true);
      expect(verifyNotesFtsIntegrity(db)).toStrictEqual({ ok: true }); // repaired in place
    } finally {
      delete process.env.OBSIDIAN_TC_VERIFY_FTS;
      db.close();
    }
  });
});
