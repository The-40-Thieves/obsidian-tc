// THE-934 — the index-time embedding boundary: a chunk under an excluded path is chunked, stored,
// and FTS/regex-searchable, but gets NO chunk_embeddings row and no gateway call. Marked with
// chunks.embedding_excluded so the audit job's null-embedding check does not flag it as a defect.
// Uses the FULL manifest chain (CACHE_MIGRATION_FILES), not a hand-built one, so migration
// 20260903_001 is always present here — this file is exactly the "manifest-driven" test category
// CLAUDE.md/`just migration-impact` describes.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { runAudit } from "../src/plane/jobs/audit";
import { indexNote, indexVault } from "../src/search/indexer";
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
      writeFileSync(join(root, "Private.md"), "a private secret about oranges");
      const stats = await indexVault({
        db,
        provider: fakeProvider,
        representation: buildRepresentationManifest(fakeProvider, {}),
        vaultId: "v1",
        root,
        isReadable: () => true,
        isEgressExcluded: (rel) => rel.startsWith("Private"),
        now: () => 1,
      });
      // Both notes are STORED — indexed, not skipped.
      expect(stats.notes_indexed).toBe(2);
      const chunks = db
        .prepare("SELECT path, content, embedding_excluded FROM chunks WHERE vault_id = 'v1'")
        .all() as Array<{ path: string; content: string; embedding_excluded: number }>;
      expect(chunks).toHaveLength(2);
      const priv = chunks.find((c) => c.path === "Private.md");
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
    const isExcluded = (rel: string) => rel.startsWith("Private/");
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
    const isExcluded = (rel: string) => rel.startsWith("Private/");
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
});
