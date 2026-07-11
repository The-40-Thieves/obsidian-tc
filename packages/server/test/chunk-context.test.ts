// THE-406 — contextual chunk enrichment. Pins: (1) with enrich on, the provider embeds
// "{title} — {breadcrumb}\n\n{content}" while chunks.content stays the raw section text;
// (2) default off embeds the raw text (byte-identical to pre-THE-406); (3) flipping the flag
// re-embeds an unchanged note (the content hash covers the enriched text); (4) BM25 matches on
// the enriched text but bm25Chunks returns the RAW content (chunks JOIN).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { bm25Chunks, ensureChunkFts } from "../src/search/chunk_fts";
import { enrichChunkText, indexNote } from "../src/search/indexer";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function baseDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  return db;
}

function capturingProvider(seen: string[]): EmbeddingProvider {
  return {
    id: "fake:embed",
    provider: "fake",
    model: "embed",
    dimensions: 3,
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
}

const RAW = "# Setup\n\nrun the reconcile nightly";
const PATH = "ops/Vault Health.md";

describe("THE-406 contextual chunk enrichment", () => {
  it("enrichChunkText prefixes title + breadcrumb; title only for preamble", () => {
    expect(enrichChunkText(PATH, ["Setup"], "body")).toBe("Vault Health — Setup\n\nbody");
    expect(enrichChunkText("A.md", [], "body")).toBe("A\n\nbody");
  });

  it("embeds the enriched text but stores the raw content", async () => {
    const db = baseDb();
    const seen: string[] = [];
    const provider = capturingProvider(seen);
    await indexNote(db, provider, "v1", PATH, RAW, false, () => 1, undefined, true);
    expect(seen).toEqual(["Vault Health — Setup\n\nrun the reconcile nightly"]);
    const row = db.prepare("SELECT content FROM chunks").get() as { content: string };
    expect(row.content).toBe("run the reconcile nightly");
  });

  it("default off embeds the raw text unchanged", async () => {
    const db = baseDb();
    const seen: string[] = [];
    await indexNote(db, capturingProvider(seen), "v1", PATH, RAW, false, () => 1);
    expect(seen).toEqual(["run the reconcile nightly"]);
  });

  it("flipping the flag re-embeds an unchanged note (hash covers the enriched text)", async () => {
    const db = baseDb();
    const seen: string[] = [];
    const provider = capturingProvider(seen);
    await indexNote(db, provider, "v1", "a.md", RAW, false, () => 1);
    expect(seen).toHaveLength(1);
    // Same note, enrichment on: the content hash differs -> re-embed, not skip.
    const r = await indexNote(db, provider, "v1", "a.md", RAW, false, () => 2, undefined, true);
    expect(r.upserted).toBe(1);
    expect(seen).toHaveLength(2);
    // Idempotent under the same flag: a third pass skips.
    const r2 = await indexNote(db, provider, "v1", "a.md", RAW, false, () => 3, undefined, true);
    expect(r2.unchanged).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it("BM25 matches on the title but returns the raw content", async () => {
    const db = baseDb();
    if (!ensureChunkFts(db)) return; // FTS5 not compiled into this runtime — no-op path is pinned elsewhere
    const seen: string[] = [];
    await indexNote(db, capturingProvider(seen), "v1", PATH, RAW, false, () => 1, undefined, true);
    const hits = bm25Chunks(db, "v1", "vault health", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("run the reconcile nightly");
  });
});
