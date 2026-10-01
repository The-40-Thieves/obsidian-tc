// Fix round (cross-vendor review): notes/FTS writes previously bypassed BOTH fences entirely —
// index-note.ts's null-plan backfill (chunks unchanged, metadata stale/missing) and
// index-vault.ts's flushNotes (the batched counterpart) wrote `notes`/`notes_fts` unconditionally,
// with no commitFence re-check at all. A stale backfill could resurrect a note's search-visible
// row after a successor's deindex tombstone, or overwrite fresher content, between the plan's read
// and this write's commit — the exact class of race note_write_fence exists to close for chunks,
// left open for metadata.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { deindexNote, indexNote, indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v1";
const PATH = "note.md";
const provider = fakeEmbeddingProvider({ dimensions: 8 });

const openDirs: Array<{ dir: string; dbA: Database; dbB: Database }> = [];

afterEach(() => {
  while (openDirs.length > 0) {
    const pair = openDirs.pop();
    try {
      pair?.dbA.close?.();
    } catch {}
    try {
      pair?.dbB.close?.();
    } catch {}
    try {
      if (pair) rmTemp(pair.dir);
    } catch {}
  }
});

async function twoConnections(): Promise<{ dir: string; dbA: Database; dbB: Database }> {
  const dir = makeTempDir("obtc-notes-fence-");
  const dbPath = join(dir, "cache.db");
  const dbA = await openDatabase(dbPath);
  provisionCacheDb(dbA);
  const dbB = await openDatabase(dbPath);
  return { dir, dbA, dbB };
}

/** Wraps a real Database so the Nth `exec("BEGIN IMMEDIATE")` fires `onBeginImmediate`
 *  synchronously before delegating — pins a competing connection's commit at the exact
 *  write-lock-acquisition instant this connection is about to reach. Mirrors
 *  index-vault-leader-epoch-race.test.ts's helper. `targetOccurrence` is 1-indexed. */
function wrapWithBeginImmediateHook(
  real: Database,
  targetOccurrence: number,
  onBeginImmediate: () => void,
): Database {
  let fired = false;
  let seen = 0;
  return {
    exec(sql: string): void {
      if (!fired && sql.trim().toUpperCase().startsWith("BEGIN IMMEDIATE")) {
        seen += 1;
        if (seen === targetOccurrence) {
          fired = true;
          onBeginImmediate();
        }
      }
      real.exec(sql);
    },
    prepare: (sql: string) => real.prepare(sql),
    prepareCached: real.prepareCached
      ? (sql: string) => real.prepareCached?.(sql) as ReturnType<Database["prepare"]>
      : undefined,
    loadExtension: real.loadExtension ? (path: string) => real.loadExtension?.(path) : undefined,
    close: real.close ? () => real.close?.() : undefined,
    inTransaction: real.inTransaction ? () => real.inTransaction?.() ?? false : undefined,
    readonlyMode: real.readonlyMode,
  };
}

describe("notes/FTS writes are fenced the same as chunk writes (cross-vendor review fix)", () => {
  it("indexNote's null-plan backfill does not resurrect a note after a concurrent deindex", async () => {
    const { dir, dbA, dbB } = await twoConnections();
    openDirs.push({ dir, dbA, dbB });

    // Seed: connection A indexes v1 content. Chunks + notes row exist; fence generation 1.
    const bodyV1 = "---\ntitle: Original\n---\n# Note\nSame body throughout.\n";
    const seed = await indexNote(dbA, provider, VAULT, PATH, bodyV1, false, () => 1);
    expect(seed.staleSkipped).toBe(false);
    const seededNotes = dbA
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = ? AND path = ?")
      .get(VAULT, PATH) as { n: number };
    expect(seededNotes.n).toBe(1);

    // The wrapped connection: the instant indexNote's null-plan backfill opens its "index_note"
    // write transaction, a REAL second connection deindexes the SAME path first — chunks, notes
    // row, and FTS row all gone, tombstone bumped — before A's own BEGIN IMMEDIATE is even issued.
    let deindexedFirst = false;
    const raceDb = wrapWithBeginImmediateHook(dbA, 1, () => {
      deindexedFirst = true;
      deindexNote(dbB, VAULT, PATH, false, false, undefined, () => 2);
    });

    // A's write: SAME body (chunks unchanged -> plan === null) but different frontmatter, so
    // notes.content_hash differs from the stored row -> the null-plan backfill branch fires.
    const bodyV1MetadataChanged = "---\ntitle: Changed Title\n---\n# Note\nSame body throughout.\n";
    const result = await indexNote(
      raceDb,
      provider,
      VAULT,
      PATH,
      bodyV1MetadataChanged,
      false,
      () => 3,
    );

    expect(deindexedFirst).toBe(true);
    expect(result.staleSkipped).toBe(true);

    // B's delete must survive — a resurrected row would mean the fence never fired.
    const afterRace = dbB
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = ? AND path = ?")
      .get(VAULT, PATH) as { n: number };
    expect(afterRace.n).toBe(0);
  });

  it("indexVault's flushNotes does not commit a stale notes-only backfill past a concurrent fresher fence bump", async () => {
    const { dir, dbA, dbB } = await twoConnections();
    openDirs.push({ dir, dbA, dbB });

    // Seed: connection A indexes v1 content directly (indexNote, not indexVault) so the on-disk
    // vault walk below sees content that ALREADY matches the stored chunks (chunks unchanged) but
    // will carry different frontmatter than what's on disk, forcing indexVault's own reconcile
    // into the null-plan notes-only backfill branch (flushNotes) for this path.
    const bodyV1 = "---\ntitle: Original\n---\n# Note\nSame body throughout.\n";
    await indexNote(dbA, provider, VAULT, PATH, bodyV1, false, () => 1);

    // A competing connection bumps this path's fence first (a fresher, unrelated write) — landing
    // exactly at flushNotes's own "index_notes_flush" write-transaction boundary (the FIRST
    // BEGIN IMMEDIATE indexVault issues, per THE-291's notes-before-chunks ordering).
    let competitorLandedFirst = false;
    const raceDb = wrapWithBeginImmediateHook(dbA, 1, () => {
      competitorLandedFirst = true;
      deindexNote(dbB, VAULT, PATH, false, false, undefined, () => 2);
    });

    const root = makeTempDir("obtc-notes-fence-vault-");
    // On-disk content: same body as seeded (chunks unchanged -> null plan), different frontmatter
    // (notes.content_hash differs -> queued for flushNotes).
    writeFileSync(
      join(root, PATH),
      "---\ntitle: Changed Title\n---\n# Note\nSame body throughout.\n",
    );
    const representation = buildRepresentationManifest(provider, {});

    const stats = await indexVault({
      db: raceDb,
      provider,
      vaultId: VAULT,
      root,
      isReadable: () => true,
      now: () => 3,
      representation,
      chunkContext: false,
    });

    expect(competitorLandedFirst).toBe(true);
    expect(stats.notes_stale_skipped).toBeGreaterThan(0);

    const afterRace = dbB
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = ? AND path = ?")
      .get(VAULT, PATH) as { n: number };
    expect(afterRace.n).toBe(0);

    rmTemp(root);
  });
});
