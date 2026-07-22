// Cross-path embedding dedup (migration 20260719_001, port of KMS THE-133 two-tier hash).
//
// content_hash is path-salted (chunk id is (vault, path, index)-keyed; the enriched embed text
// carries the note title), so identical content pasted at two paths embeds + stores TWICE today.
// body_sha keys on the RAW chunk body alone, so the indexer embeds the first walked copy ONCE and,
// for the rest, COPIES that stored vector rather than re-calling the provider (THE-454). The dedup
// saving is the avoided provider call; every path still gets its own stored vector so it stays
// retrievable by dense/sparse/ColBERT (not just FTS) and deleting the owner cannot strand it.
// These tests pin: (1) one provider CALL but a vector per path for a shared body; (2) two providers
// calls for distinct bodies; (3) on a pre-migration cache.db without the body_sha column the copy
// can't match, so dedup is disabled and every chunk embeds (correctness over the optimization);
// (4) cross-run dedup still avoids the provider call while copying the vector; (5) both duplicate
// paths keep an independent vector, so the survivor is not stranded when the owner is deleted.
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

      // The provider is called exactly ONCE for the shared body (the dedup saving)...
      expect(embedded.length).toBe(1);
      // ...but BOTH paths get a stored vector (THE-454: the second is COPIED, not recomputed), so
      // each path is retrievable by dense search, not just FTS.
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(2);

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
      // Simulate a cache.db provisioned before migration 20260719_001. Every index over body_sha
      // must go first — SQLite refuses to drop a column an index still references. THE-502 added a
      // second one (idx_chunks_dedup), so this list grows with the schema.
      //
      // Production never reaches this state: migrations only add. The DROP COLUMN here exists purely
      // to manufacture an old database that the graceful-degrade path can be tested against.
      //
      // ORDERING MATTERS since THE-491: hasBodyShaColumn is memoized per connection, so this must
      // happen BEFORE the first index_vault call. If indexing ran first the probe would be cached
      // as true and this test would exercise the wrong path — passing or failing for reasons
      // unrelated to graceful degradation.
      v.db.exec("DROP INDEX IF EXISTS chunks_body_sha");
      v.db.exec("DROP INDEX IF EXISTS idx_chunks_dedup");
      v.db.exec("ALTER TABLE chunks DROP COLUMN body_sha");

      const res: ToolResult = await v.call("index_vault", { vault: v.id });
      // No crash; both chunks still stored.
      expect(res.ok).toBe(true);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks")).toBe(2);

      // THE-454: without the body_sha column the vector-copy cannot match a sibling, so dedup is
      // DISABLED here — every chunk is embedded, keeping both paths retrievable (correctness over the
      // optimization on a legacy pre-migration cache.db).
      expect(embedded.length).toBe(2);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(2);
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

      // Cross-run dedup: two.md reuses one.md's embedding via the seeded registry → the provider is
      // still called only ONCE, but two.md gets a COPIED vector (THE-454), so both paths are stored
      // and dense-retrievable.
      expect(embedded.length).toBe(1);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(2);
      expect(count(v, "SELECT COUNT(*) AS n FROM chunks")).toBe(2);
    } finally {
      v.cleanup();
    }
  });

  // THE-454 × THE-406 regression: enrichChunkText salts the embed text with the note TITLE
  // (filename), so two notes with an IDENTICAL raw body but DIFFERENT titles embed DIFFERENT text and
  // must NOT share a vector. Keying cross-path dedup on the raw body (body_sha) copied the first
  // note's title-enriched vector onto the second — the second's embedding then encoded the WRONG
  // title. Dedup must key on the embedded-text identity (content_hash), which is title-salted when
  // enrichment is on and equal to the raw-body hash when it is off.
  describe("under contextual enrichment (THE-406)", () => {
    // A provider whose vector DEPENDS on the text, so a wrongly-copied vector is observable.
    function textDerivedProvider(): { provider: EmbeddingProvider; embedded: string[] } {
      const embedded: string[] = [];
      const vec = (t: string): number[] => {
        let h = 0;
        for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 1000;
        return Array.from({ length: 8 }, (_, i) => ((h + i) % 1000) / 1000);
      };
      const provider: EmbeddingProvider = {
        id: "td",
        provider: "td",
        model: "m",
        dimensions: 8,
        async embed(texts: string[]): Promise<number[][]> {
          for (const t of texts) embedded.push(t);
          return texts.map(vec);
        },
      };
      return { provider, embedded };
    }
    const BODY = "This identical body sits under two DIFFERENTLY-TITLED notes.";

    it("embeds each title separately — the second is NOT given the first's vector", async () => {
      const { provider, embedded } = textDerivedProvider();
      const v = makeM2Vault({
        files: { "alpha.md": BODY, "beta.md": BODY },
        provider,
        chunkContext: true,
      });
      try {
        expect((await v.call("index_vault", { vault: v.id })).ok).toBe(true);

        // Under enrichment the two enriched texts differ, so BOTH are embedded (no cross-path skip)…
        expect(embedded.length).toBe(2);
        expect(embedded.some((t) => t.startsWith("alpha"))).toBe(true);
        expect(embedded.some((t) => t.startsWith("beta"))).toBe(true);

        // …and the two stored vectors DIFFER. Before the fix beta.md was handed alpha.md's vector.
        const rows = v.db
          .prepare(
            "SELECT c.path AS path, e.embedding AS embedding FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id ORDER BY c.path",
          )
          .all() as Array<{ path: string; embedding: Uint8Array }>;
        expect(rows.length).toBe(2);
        const [a, b] = rows;
        if (!a || !b) throw new Error("expected two embedding rows");
        expect(Buffer.from(a.embedding).equals(Buffer.from(b.embedding))).toBe(false);
      } finally {
        v.cleanup();
      }
    });

    it("still dedups genuinely identical enriched text (same title + body at two paths)", async () => {
      // Same body under the SAME title (dup.md and sub/dup.md both enrich to title "dup").
      const { provider, embedded } = textDerivedProvider();
      const v = makeM2Vault({
        files: { "dup.md": BODY, "sub/dup.md": BODY },
        provider,
        chunkContext: true,
      });
      try {
        expect((await v.call("index_vault", { vault: v.id })).ok).toBe(true);
        // Identical enriched text → embed once, copy the sibling's (correct) vector for the rest.
        expect(embedded.length).toBe(1);
        expect(count(v, "SELECT COUNT(*) AS n FROM chunk_embeddings")).toBe(2);
      } finally {
        v.cleanup();
      }
    });
  });

  it("keeps an independent vector per path, so deleting the owner never strands the survivor (THE-454)", async () => {
    const { provider, embedded } = countingProvider();
    const v = makeM2Vault({ files: { "one.md": SHARED, "two.md": SHARED }, provider });
    const embCount = (id: string): number =>
      (
        v.db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings WHERE chunk_id = ?").get(id) as {
          n: number;
        }
      ).n;
    try {
      expect((await v.call("index_vault", { vault: v.id })).ok).toBe(true);
      expect(embedded.length).toBe(1); // provider still called once

      // Every chunk row — including the deduped duplicate — now carries its own embedding.
      const allIds = (v.db.prepare("SELECT id FROM chunks").all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
      expect(allIds.length).toBeGreaterThan(1);
      for (const id of allIds) expect(embCount(id)).toBe(1);

      // Delete the vector-OWNING path (one.md) and its embedding, as deindex would.
      const survivors = (
        v.db.prepare("SELECT id FROM chunks WHERE path = 'two.md'").all() as Array<{ id: string }>
      ).map((r) => r.id);
      v.db.exec(
        "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE path = 'one.md')",
      );
      v.db.exec("DELETE FROM chunks WHERE path = 'one.md'");

      // The survivor keeps its own vector — before THE-454 it had none and vanished from dense search.
      for (const id of survivors) expect(embCount(id)).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});
