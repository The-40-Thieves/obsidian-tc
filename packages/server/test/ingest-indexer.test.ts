import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { type IndexedChunk, indexNote, indexVault } from "../src/search/indexer";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

const fakeProvider: EmbeddingProvider = {
  id: "fake:embed",
  provider: "fake",
  model: "embed",
  dimensions: 3,
  embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
};

function baseDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );
     CREATE UNIQUE INDEX idx_vault_edges_unique ON vault_edges(source_path, target_path, edge_type);`,
  );
  return db;
}

describe("W-INGEST indexer fold", () => {
  it("secret-gate skips a secretful chunk; onIndexed fires with the clean chunks", async () => {
    const db = baseDb();
    const captured: IndexedChunk[] = [];
    const raw = "# Public\nThis is fine.\n\n# Secret\nkey AKIAIOSFODNN7EXAMPLE here\n";
    const r = await indexNote(
      db,
      fakeProvider,
      "v1",
      "n.md",
      raw,
      false,
      () => 1,
      (chunks) => {
        captured.push(...chunks);
      },
    );
    expect(r.secretsSkipped).toBe(1);
    const stored = db.prepare("SELECT content FROM chunks WHERE vault_id = 'v1'").all() as Array<{
      content: string;
    }>;
    expect(stored.length).toBe(1);
    expect(stored[0]?.content).toContain("This is fine");
    expect(stored.some((s) => s.content.includes("AKIA"))).toBe(false);
    expect(captured.length).toBe(1);
    expect(captured[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("indexVault produces forward+reverse links_to and unresolved edges into vault_edges", async () => {
    const db = baseDb();
    const root = mkdtempSync(join(tmpdir(), "obtc-ingest-"));
    try {
      writeFileSync(join(root, "A.md"), "links to [[B]] and [[Ghost]]");
      writeFileSync(join(root, "B.md"), "the target note");
      const stats = await indexVault({
        db,
        provider: fakeProvider,
        vaultId: "v1",
        root,
        isReadable: () => true,
        now: () => 1,
      });
      expect(stats.edges_inserted).toBeGreaterThanOrEqual(3); // A->B, B->A, A->Ghost
      const edges = db
        .prepare("SELECT source_path, target_path, edge_type FROM vault_edges")
        .all() as Array<{ source_path: string; target_path: string; edge_type: string }>;
      const has = (s: string, t: string, type: string): boolean =>
        edges.some((e) => e.source_path === s && e.target_path === t && e.edge_type === type);
      expect(has("A.md", "B.md", "links_to")).toBe(true);
      expect(has("B.md", "A.md", "links_to")).toBe(true);
      expect(has("A.md", "Ghost", "unresolved")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
