// Cross-path embedding dedup (migration 20260719_001, port of KMS THE-133 two-tier hash).
//
// content_hash is path-salted (chunk id is (vault, path, index)-keyed; the enriched embed text
// carries the note title), so identical content pasted at two paths embeds + stores TWICE today.
// body_sha keys on the RAW chunk body alone, so the indexer can embed the first walked copy and
// STORE-but-skip-embedding the rest. These tests pin: (1) one embedding for a body shared across two
// paths, both chunks still stored; (2) two embeddings for distinct bodies; (3) graceful degradation
// when the body_sha column is absent (older cache.db) — no crash, chunks still stored, and the
// in-memory per-run registry still dedups.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings";
import { makeM2Vault } from "./m2-helpers";

// Records every text handed to the provider, so a run's embedding count is observable.
function countingProvider(): { provider: EmbeddingProvider; embedded: string[] } {
  const embedded: string[] = [];
  const provider: EmbeddingProvider = {
    id: "count",
    provider: "count",
    model: "m",
    dimensions: 8,
    async embed(texts: string[]): Promise<number[][]> {
      for (const t of texts) embedded.push(t);
      return texts.map(() => Array.from({ length: 8 }, () => 0.1));
    },
  };
  return { provider, embedded };
}

const count = (v: ReturnType<typeof makeM2Vault>, sql: string): number =>
  (v.db.prepare(sql).get() as { n: number }).n;

const SHARED = "# Shared Note\n\nThis identical body is pasted at two different paths for dedup.";

describe("body_sha cross-path embedding dedup (migration 20260719_001)", () => {
  it("embeds an identical body ONCE across two paths, but STORES both chunks", async () => {
    const { provider, embedded } = countingProvider();
    const v = makeM2Vault({ files: { "one.md": SHARED, "two.md": SHARED }, provider });
    try {
      const res: ToolResult = await v.call("index_vault", { vault: v.id });
      expect(res.ok).toBe(true);

      // Exactly ONE embedding computed for the shared body...
      expect(embedded.length).toBe(1);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(1);

      // ...yet BOTH paths are stored as chunk rows.
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks WHERE path = 'one.md'")).toBe(1);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks WHERE path = 'two.md'")).toBe(1);

      // Both rows carry the same, populated body_sha.
      const shas = (
        v.db.prepare("SELECT path, body_sha FROM chunks ORDER BY path").all() as Array<{
          path: string;
          body_sha: string | null;
        }>
      ).map((r) => r.body_sha);
      expect(shas[0]).toBeTruthy();
      expect(shas[0]).toBe(shas[1]);
    } finally {
      v.cleanup();
    }
  });

  it("embeds TWO distinct bodies twice", async () => {
    const { provider, embedded } = countingProvider();
    const v = makeM2Vault({
      files: {
        "one.md": "# A\n\nfirst distinct body alpha.",
        "two.md": "# B\n\nsecond distinct body beta.",
      },
      provider,
    });
    try {
      const res: ToolResult = await v.call("index_vault", { vault: v.id });
      expect(res.ok).toBe(true);
      expect(embedded.length).toBe(2);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(2);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks")).toBe(2);
    } finally {
      v.cleanup();
    }
  });

  it("degrades gracefully when the body_sha column is absent (pre-migration cache.db)", async () => {
    const { provider, embedded } = countingProvider();
    const v = makeM2Vault({ files: { "one.md": SHARED, "two.md": SHARED }, provider });
    try {
      // Simulate a cache.db provisioned before migration 20260719_001.
      v.db.exec("DROP INDEX IF EXISTS chunks_body_sha");
      v.db.exec("ALTER TABLE chunks DROP COLUMN body_sha");

      const res: ToolResult = await v.call("index_vault", { vault: v.id });
      // No crash; both chunks still stored.
      expect(res.ok).toBe(true);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks")).toBe(2);

      // The per-run dedup registry is in-memory, so cross-path dedup still holds without the column.
      expect(embedded.length).toBe(1);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("dedups across separate index RUNS by seeding the registry from the persisted column (THE-445)", async () => {
    const { provider, embedded } = countingProvider();
    const v = makeM2Vault({ files: { "one.md": SHARED }, provider });
    try {
      // Run A: index one.md alone → one embedding, one chunk carrying the body_sha.
      expect((await v.call("index_vault", { vault: v.id })).ok).toBe(true);
      expect(embedded.length).toBe(1);

      // Add a NEW path with the identical body AFTER run A, then run B (a fresh walk whose in-memory
      // registry starts empty — only the persisted-column seed can dedup two.md against one.md).
      writeFileSync(join(v.root, "two.md"), SHARED);
      expect((await v.call("index_vault", { vault: v.id })).ok).toBe(true);

      // Cross-run dedup: two.md reuses one.md's embedding → still ONE embedding total, both stored.
      expect(embedded.length).toBe(1);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(1);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks")).toBe(2);
    } finally {
      v.cleanup();
    }
  });
});
