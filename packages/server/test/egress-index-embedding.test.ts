// THE-934 — the index-time embedding boundary: a chunk under an excluded path is chunked, stored,
// and FTS/regex-searchable, but gets NO chunk_embeddings row and no gateway call. Marked with
// chunks.embedding_excluded so the audit job's null-embedding check does not flag it as a defect.
// Uses the FULL manifest chain (CACHE_MIGRATION_FILES), not a hand-built one, so migration
// 20260903_001 is always present here — this file is exactly the "manifest-driven" test category
// CLAUDE.md/`just migration-impact` describes.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { compileEgressFilter, isExcludedPath } from "../src/plane/egress-filter";
import { runAudit } from "../src/plane/jobs/audit";
import { indexNote, indexVault } from "../src/search/indexer";
import { applyNoteWrites } from "../src/search/indexing/persist-note-plan";
import { existingSummaryHash, upsertNoteSummary } from "../src/search/note-summaries";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CACHE_CHAIN = CACHE_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

function baseDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, CACHE_CHAIN);
  return db;
}

let embedCalls = 0;
const fakeProvider: EmbeddingProvider = {
  id: "fake:embed",
  provider: "fake",
  model: "embed",
  dimensions: 3,
  embed: async (texts) => {
    embedCalls += texts.length;
    return texts.map(() => [0.1, 0.2, 0.3]);
  },
};

describe("index-time embedding — egress.excludePaths (THE-934)", () => {
  it("an excluded note is chunked and stored, but NEVER embedded — zero embed calls for it", async () => {
    embedCalls = 0;
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-"));
    try {
      writeFileSync(join(root, "Public.md"), "a public note about apples");
      mkdirSync(join(root, "Private"), { recursive: true });
      writeFileSync(join(root, "Private", "secret.md"), "a private secret about oranges");
      const stats = await indexVault({
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: (rel) => isExcludedPath(compileEgressFilter(["Private/**"]), rel),
        now: () => 1,
      });
      // Both notes are STORED — indexed, not skipped.
      expect(stats.notes_indexed).toBe(2);
      const chunks = db
        .prepare("SELECT path, content, embedding_excluded FROM chunks WHERE vault_id = 'v1'")
        .all() as Array<{ path: string; content: string; embedding_excluded: number }>;
      expect(chunks).toHaveLength(2);
      const priv = chunks.find((c) => c.path === "Private/secret.md");
      const pub = chunks.find((c) => c.path === "Public.md");
      expect(priv?.embedding_excluded).toBe(1);
      expect(pub?.embedding_excluded).toBe(0);
      // No chunk_embeddings row for the excluded chunk — never sent to the provider.
      const embRows = db
        .prepare(
          "SELECT c.path AS path FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.vault_id = 'v1'",
        )
        .all() as Array<{ path: string }>;
      expect(embRows.map((r) => r.path)).toEqual(["Public.md"]);
      // The fake provider was only ever asked to embed the PUBLIC note's text — proof by request
      // payload (the embed call count), not by a mock echo of the result.
      expect(embedCalls).toBe(1);
    } finally {
      rmTemp(root);
    }
  });

  // THE-934 fix round 3 (H): the tests above re-typed the predicate as `rel.startsWith("Private")`
  // — looser than the real glob (it would ALSO match a note literally named "Private.md" or
  // "Privateer.md", neither of which is nested under a "Private/" folder) — so this file could
  // never catch a regression in the actual production glob semantics. This test goes through the
  // REAL `compileEgressFilter`/`isExcludedPath` and the real indexVault pipeline, and pins the
  // must-NOT-match cases a substring predicate would have gotten wrong.
  it("real glob semantics: Private.md and Privateer.md (files, not the Private/ folder) are NOT excluded", async () => {
    embedCalls = 0;
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-glob-"));
    try {
      writeFileSync(join(root, "Private.md"), "a file literally named Private.md");
      writeFileSync(join(root, "Privateer.md"), "a file that merely starts with Private");
      const filter = compileEgressFilter(["Private/**"]);
      const stats = await indexVault({
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: (rel) => isExcludedPath(filter, rel),
        now: () => 1,
      });
      expect(stats.notes_indexed).toBe(2);
      const chunks = db
        .prepare("SELECT path, embedding_excluded FROM chunks WHERE vault_id = 'v1'")
        .all() as Array<{ path: string; embedding_excluded: number }>;
      expect(chunks.every((c) => c.embedding_excluded === 0)).toBe(true);
      expect(embedCalls).toBe(2); // both notes reached the provider
    } finally {
      rmTemp(root);
    }
  });

  it("audit's null-embedding count stays 0 for an excluded chunk (the marker's whole point)", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-audit-"));
    try {
      writeFileSync(join(root, "Private.md"), "a private secret about oranges");
      await indexVault({
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: () => true,
        now: () => 1,
      });
      const { report, hasIssues } = runAudit(db, () => 1);
      expect(report.vault_null_embeddings).toBe(0);
      expect(hasIssues).toBe(false);
    } finally {
      rmTemp(root);
    }
  });

  it("a real (non-excluded) null embedding is STILL flagged — the filter narrows, it doesn't blind", async () => {
    const db = baseDb();
    // Insert a chunk with no chunk_embeddings row and embedding_excluded = 0 (the default) — a
    // genuine defect, e.g. an embed that failed mid-reconcile.
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'c', 'h', 1, 0, 0)",
    ).run();
    const { report, hasIssues } = runAudit(db, () => 1);
    expect(report.vault_null_embeddings).toBe(1);
    expect(hasIssues).toBe(true);
  });

  // Reviewer's Probe 1 (THE-934 fix round 1, Blocking-1) reproduced as a test: `indexNote` is the
  // SINGLE-NOTE index-on-write path -- what write_note/append_note/patch_note and the filesystem
  // watcher actually call while the server is running (wireIndexCoordinator's `write` hook,
  // runtime/indexing-wiring.ts). Before the fix, this path had no `isExcluded` parameter at all and
  // sent excluded note text straight to the embedding provider.
  it("B1 (fix round 1): a note written under an excluded folder is NEVER embedded — zero provider calls, embedding_excluded=1", async () => {
    embedCalls = 0;
    const db = baseDb();
    const isExcluded = (rel: string) => isExcludedPath(compileEgressFilter(["Private/**"]), rel);
    await indexNote(
      db,
      fakeProvider,
      "v1",
      "Private/secret.md",
      "a private secret about oranges",
      false, // hasVec
      () => 1,
      undefined, // onIndexed
      false, // enrich
      undefined, // sql
      isExcluded,
    );
    expect(embedCalls).toBe(0);
    const row = db
      .prepare("SELECT content, embedding_excluded FROM chunks WHERE vault_id = 'v1'")
      .get() as { content: string; embedding_excluded: number } | undefined;
    expect(row?.content).toBe("a private secret about oranges"); // still stored
    expect(row?.embedding_excluded).toBe(1);
    const embRow = db.prepare("SELECT chunk_id FROM chunk_embeddings").get();
    expect(embRow).toBeUndefined();
  });

  it("B1 control: a NON-excluded note through indexNote embeds normally (the fix narrows, it doesn't blind)", async () => {
    embedCalls = 0;
    const db = baseDb();
    const isExcluded = (rel: string) => isExcludedPath(compileEgressFilter(["Private/**"]), rel);
    await indexNote(
      db,
      fakeProvider,
      "v1",
      "Public/note.md",
      "a public note about apples",
      false,
      () => 1,
      undefined,
      false,
      undefined,
      isExcluded,
    );
    expect(embedCalls).toBe(1);
    const row = db.prepare("SELECT embedding_excluded FROM chunks WHERE vault_id = 'v1'").get() as
      | { embedding_excluded: number }
      | undefined;
    expect(row?.embedding_excluded).toBe(0);
    const embRow = db.prepare("SELECT chunk_id FROM chunk_embeddings").get();
    expect(embRow).toBeDefined();
  });

  it("a renamed-OUT-of-excluded folder is re-embedded on the next pass (content_hash unchanged)", async () => {
    embedCalls = 0;
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-rename-"));
    try {
      writeFileSync(join(root, "Private.md"), "stable content, never edited");
      const args = {
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        now: () => 1,
      };
      await indexVault({ ...args, isEgressExcluded: () => true });
      expect(
        (db.prepare("SELECT embedding_excluded AS e FROM chunks").get() as { e: number }).e,
      ).toBe(1);
      expect(embedCalls).toBe(0);

      // "Rename" out of the excluded folder: same content, exclusion now false on the next pass.
      await indexVault({ ...args, isEgressExcluded: () => false });
      expect(
        (db.prepare("SELECT embedding_excluded AS e FROM chunks").get() as { e: number }).e,
      ).toBe(0);
      expect(embedCalls).toBe(1); // now actually embedded, despite content_hash never changing
      const embRow = db.prepare("SELECT chunk_id FROM chunk_embeddings").get();
      expect(embRow).toBeDefined();
    } finally {
      rmTemp(root);
    }
  });

  // THE-934 fix round 3 (D): persist-note-plan.ts stripped a chunk's OWN vectors on exclusion but
  // left a prior `note_summaries` row (search/indexing/summarize-notes.ts's table) untouched --
  // summarize-notes.ts's own filter only skips REGENERATING a summary for an excluded note, never
  // removes an existing one. A stale summary stayed searchable (searchNoteSummaries) and kept
  // feeding buildClusterSummaries' k-means membership even after the note it came from was
  // excluded.
  it("a note transitioning to excluded has its note_summaries row deleted, not merely its chunk vectors", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-summary-"));
    try {
      writeFileSync(join(root, "Journal.md"), "stable content, never edited");
      const args = {
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        now: () => 1,
      };
      // First pass: the note is public, indexed and embedded normally. Simulate a PRIOR
      // summarize-notes.ts pass having already written a note_summaries row for it (a separate
      // job from indexVault, so it does not run here).
      await indexVault({ ...args, isEgressExcluded: () => false });
      upsertNoteSummary(db, "v1", {
        path: "Journal.md",
        contentHash: "some-hash",
        summary: "a note summary written before exclusion",
        model: "m",
        embedding: [1, 0, 0, 0],
        embeddingModel: "e",
        createdAt: 1,
      });
      expect(existingSummaryHash(db, "v1", "Journal.md")).toBe("some-hash");

      // Second pass: the folder becomes excluded (config change, content_hash unchanged). The
      // stale note_summaries row must be deleted, not merely the chunk's own vectors.
      await indexVault({ ...args, isEgressExcluded: () => true });
      expect(existingSummaryHash(db, "v1", "Journal.md")).toBeNull();
      const row = db
        .prepare("SELECT * FROM note_summaries WHERE vault_id = 'v1' AND path = 'Journal.md'")
        .get();
      expect(row).toBeUndefined();
    } finally {
      rmTemp(root);
    }
  });

  // THE-934 fix round 4 (2): the round-3 cleanup fired only on the exclusion TRANSITION. It hung
  // off `plan.toEmbed[0]?.excludedFromEmbed`, and computeNotePlan returns NO PLAN AT ALL for a note
  // whose chunks are unchanged -- which is the steady state of a note already stamped
  // `embedding_excluded = 1` by an earlier reconcile. So a vault that was already excluded before
  // this ticket shipped (or before the summary row was written) kept that row for ever, searchable
  // through searchNoteSummaries and feeding buildClusterSummaries' membership. This test starts
  // from the ALREADY-excluded state -- no transition anywhere in it.
  it("an ALREADY-excluded note (stamped on a previous pass, no transition) loses its summary on the NEXT reconcile", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-stale-summary-"));
    try {
      writeFileSync(join(root, "Journal.md"), "stable content, never edited");
      const args = {
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: () => true,
        now: () => 1,
      };
      // Pass 1: the note is excluded from the start, so it is stamped and never embedded.
      await indexVault(args);
      expect(
        (db.prepare("SELECT embedding_excluded AS e FROM chunks").get() as { e: number }).e,
      ).toBe(1);

      // A summary row exists anyway -- exactly what a pre-THE-934 install has: written by an
      // earlier summarize pass, or by a reconcile that ran before the folder was excluded.
      upsertNoteSummary(db, "v1", {
        path: "Journal.md",
        contentHash: "stale-hash",
        summary: "a note summary written before the exclusion was configured",
        model: "m",
        embedding: [1, 0, 0, 0],
        embeddingModel: "e",
        createdAt: 1,
      });
      expect(existingSummaryHash(db, "v1", "Journal.md")).toBe("stale-hash");

      // Pass 2: nothing changed -- same content, same exclusion status. computeNotePlan produces
      // NO plan, so the cleanup must come from the walk itself.
      await indexVault(args);
      expect(existingSummaryHash(db, "v1", "Journal.md")).toBeNull();
    } finally {
      rmTemp(root);
    }
  });

  // THE-934 fix round 4 (2): the reconcile WALK's own sweep, isolated from applyNoteWrites. An
  // excluded note normally still produces a write plan on every pass (an excluded chunk can never
  // hold an active embedding, so computeNotePlan's THE-531 model gate keeps re-planning it), which
  // is why persist-note-plan.ts's DELETE covers the common case. A note with NO chunks at all --
  // emptied on disk, or every chunk secret-gated -- produces `plan: null`, so nothing downstream of
  // computeNotePlan runs for it and only the walk can clean up. Its summary row is real: it was
  // written when the note still had content.
  it("an excluded note with NO chunks at all (plan: null) still loses its summary — the walk sweeps it", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-empty-"));
    try {
      writeFileSync(join(root, "Emptied.md"), "");
      upsertNoteSummary(db, "v1", {
        path: "Emptied.md",
        contentHash: "hash-from-when-it-had-content",
        summary: "a summary of the note's PREVIOUS, non-empty content",
        model: "m",
        embedding: [1, 0, 0, 0],
        embeddingModel: "e",
        createdAt: 1,
      });
      await indexVault({
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: () => true,
        now: () => 1,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toMatchObject({ n: 0 });
      expect(existingSummaryHash(db, "v1", "Emptied.md")).toBeNull();
    } finally {
      rmTemp(root);
    }
  });

  // THE-934 fix round 4 (2): the SINGLE-NOTE write path (write_note/append_note/patch_note and the
  // filesystem watcher) does not go through index-vault.ts's walk, so it carries its own cleanup —
  // persist-note-plan.ts's DELETE, now keyed on the note-level `plan.excluded`.
  it("indexNote: writing a note under an excluded folder deletes its summary row too", async () => {
    const db = baseDb();
    const isExcluded = (rel: string) => isExcludedPath(compileEgressFilter(["Private/**"]), rel);
    upsertNoteSummary(db, "v1", {
      path: "Private/secret.md",
      contentHash: "stale-hash",
      summary: "a summary written before the folder was excluded",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    await indexNote(
      db,
      fakeProvider,
      "v1",
      "Private/secret.md",
      "a private secret about oranges",
      false,
      () => 1,
      undefined,
      false,
      undefined,
      isExcluded,
    );
    expect(existingSummaryHash(db, "v1", "Private/secret.md")).toBeNull();
  });

  // THE-934 fix round 4 (2): the note-level flag itself. A plan with an EMPTY toEmbed is a real
  // plan (a prune with no re-embed), and round 3 read `plan.toEmbed[0]?.excludedFromEmbed`, which
  // is `undefined` for exactly that plan — so the cleanup silently did not run. Asserted directly
  // against applyNoteWrites so the pin is on the condition, not on a pipeline that happens to
  // produce a non-empty toEmbed.
  it("applyNoteWrites deletes the summary for an excluded note even when the plan re-embeds NOTHING", () => {
    const db = baseDb();
    upsertNoteSummary(db, "v1", {
      path: "Private/secret.md",
      contentHash: "stale-hash",
      summary: "a summary that must not survive an excluded note's prune-only plan",
      model: "m",
      embedding: [1, 0, 0, 0],
      embeddingModel: "e",
      createdAt: 1,
    });
    applyNoteWrites(
      db,
      fakeProvider,
      "v1",
      {
        path: "Private/secret.md",
        existing: [],
        desiredIds: new Set<string>(),
        toEmbed: [], // nothing changed about this note's chunks
        excluded: true,
        vectors: [],
        ts: 1,
      },
      false,
      false,
      false,
      false,
      false,
      new Map(),
    );
    expect(existingSummaryHash(db, "v1", "Private/secret.md")).toBeNull();
  });

  it("control: a note that is NOT excluded keeps its summary row across reconciles", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-egress-keep-summary-"));
    try {
      writeFileSync(join(root, "Journal.md"), "stable content, never edited");
      const args = {
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: () => false,
        now: () => 1,
      };
      await indexVault(args);
      upsertNoteSummary(db, "v1", {
        path: "Journal.md",
        contentHash: "live-hash",
        summary: "a summary of a perfectly public note",
        model: "m",
        embedding: [1, 0, 0, 0],
        embeddingModel: "e",
        createdAt: 1,
      });
      await indexVault(args);
      expect(existingSummaryHash(db, "v1", "Journal.md")).toBe("live-hash");
    } finally {
      rmTemp(root);
    }
  });
});
