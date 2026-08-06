// THE-632 (security): the lexical and sparse arms must apply the read ACL AT QUERY TIME.
//
// Found by cross-vendor review of the diagnose_retrieval PR. The dense arm has filtered at query
// time since THE-287, whose comment names the exact hazard: "the ACL existence side-channel where
// a global KNN's top-N is dominated by chunks the caller cannot see". The lexical (BM25) and
// sparse arms never received the same treatment — they queried the whole vault and were filtered
// downstream in candidate_assembly.
//
// Filtering downstream removes unreadable hits from the RESULTS but not from the counts, and two
// things follow:
//
//   1. DISCLOSURE. Any aggregate over these arrays leaks the existence of unreadable content. It
//      was reachable through diagnose_retrieval, whose candidatesIn summed the pre-ACL arrays:
//      query a rare term, watch the count move, learn the term appears in a note you cannot read.
//      A cross-ACL content-membership oracle.
//   2. CROWDING. Unreadable chunks occupy slots inside each arm's own top-k, so a caller can lose
//      real hits to notes they are not permitted to see.
//
// These tests assert the arms themselves, not the tool — the leak was in the arms, and a fix at
// the tool would have left the crowding and any future aggregate exposed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { bm25Chunks, ensureChunkFts } from "../src/search/chunk_fts";
import { ensureChunkSparse, sparseSearch, upsertChunkSparse } from "../src/search/sparse";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const PRIVATE = "09-private/secret.md";

function seedDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  return db;
}

function addChunk(db: Database, id: string, path: string, content: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", 4, floatBlob([1, 0, 0, 0]));
}

/** Deny exactly the private folder — the shape a real folder ACL produces. */
const readable = (p: string): boolean => !p.startsWith("09-private/");

/**
 * FTS5 availability, with the two causes kept DISTINCT — they deserve opposite outcomes.
 *
 * These tests originally `return`ed early when FTS5 was missing, so they could report PASSED having
 * asserted nothing; a security suite that is green because it ran nothing states the property as
 * HELD. The first fix threw unconditionally, which over-corrected: `OBSIDIAN_TC_DISABLE_FTS=1` is a
 * SUPPORTED opt-out (see chunk_fts.ts), so a contributor exercising it would get a hard failure for
 * doing something legitimate.
 *
 * So: deliberate opt-out reports SKIPPED (visible in the runner, never mistaken for a pass), and an
 * UNEXPECTED absence still throws, because that is the regression case — CI never sets the env var
 * and compiles FTS5 on all four build-test platforms.
 */
function ftsState(db: Database): "ok" | "deliberately-disabled" {
  if (ensureChunkFts(db)) return "ok";
  if (process.env.OBSIDIAN_TC_DISABLE_FTS === "1") return "deliberately-disabled";
  throw new Error(
    "FTS5 is unavailable and OBSIDIAN_TC_DISABLE_FTS is not set — THE-632's ACL assertions cannot " +
      "run and this suite refuses to pass vacuously. Set the env var if the omission is intended.",
  );
}

describe("THE-632: BM25 applies the read ACL before its top-k cut", () => {
  it("never returns an unreadable chunk, even when it is the ONLY match", (ctx) => {
    expect.hasAssertions();
    const db = seedDb();
    // The rare term exists in exactly one note, and that note is unreadable. Without query-time
    // filtering the caller gets a hit — and, worse, a COUNT that betrays the term's existence.
    addChunk(db, "priv", PRIVATE, "zarquon classified codeword");
    addChunk(db, "pub", "00-public.md", "ordinary public words");
    ctx.skip(ftsState(db) === "deliberately-disabled", "OBSIDIAN_TC_DISABLE_FTS=1");

    const leaky = bm25Chunks(db, VAULT, "zarquon", 10);
    const guarded = bm25Chunks(db, VAULT, "zarquon", 10, readable);

    // Without the ACL the term is findable — this is what proves the test is not vacuous.
    expect(leaky.map((h) => h.path)).toContain(PRIVATE);
    // With it, nothing at all: no hit, and no count to infer one from.
    expect(guarded).toHaveLength(0);
  });

  it("does not let unreadable chunks crowd out readable ones inside the limit", (ctx) => {
    expect.hasAssertions();
    const db = seedDb();
    // Many unreadable matches, one readable. Asking for k=1 with filtering applied only AFTER the
    // SQL limit would return nothing — the private chunks would have consumed the slot.
    for (let i = 0; i < 12; i++) addChunk(db, `p${i}`, `09-private/n${i}.md`, "shared term here");
    addChunk(db, "vis", "00-visible.md", "shared term here");
    ctx.skip(ftsState(db) === "deliberately-disabled", "OBSIDIAN_TC_DISABLE_FTS=1");

    const hits = bm25Chunks(db, VAULT, "shared term", 1, readable);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("00-visible.md");
  });
});

describe("THE-632: sparse search applies the read ACL before its top-k cut", () => {
  // THE-711: writes go through the PRODUCTION writer rather than hand-rolled SQL. This helper
  // used to INSERT a JSON.stringify'd blob into a `weights` column directly, which meant the
  // fixture encoded the storage format and broke the moment that format changed. upsertChunkSparse
  // owns the encoding; the test should only own the values.
  const addSparse = (db: Database, id: string, weights: Record<string, number>): void => {
    ensureChunkSparse(db);
    upsertChunkSparse(db, id, VAULT, weights);
  };

  it("never returns an unreadable chunk, even as the strongest match", () => {
    expect.hasAssertions();
    const db = seedDb();
    addChunk(db, "priv", PRIVATE, "classified");
    addChunk(db, "pub", "00-public.md", "ordinary");
    addSparse(db, "priv", { 4242: 9.0 });
    addSparse(db, "pub", { 9999: 0.1 });

    const leaky = sparseSearch(db, VAULT, { 4242: 1.0 }, 10);
    const guarded = sparseSearch(db, VAULT, { 4242: 1.0 }, 10, readable);

    expect(leaky.map((h) => h.path)).toContain(PRIVATE);
    expect(guarded).toHaveLength(0);
  });

  it("filtering is EXACT here — the scan is exhaustive, so no crowding is possible", () => {
    expect.hasAssertions();
    const db = seedDb();
    for (let i = 0; i < 12; i++) {
      addChunk(db, `p${i}`, `09-private/n${i}.md`, "x");
      addSparse(db, `p${i}`, { 77: 5.0 });
    }
    addChunk(db, "vis", "00-visible.md", "x");
    addSparse(db, "vis", { 77: 0.01 }); // weakest match, would never survive a top-1 cut

    const hits = sparseSearch(db, VAULT, { 77: 1.0 }, 1, readable);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("00-visible.md");
  });
});
