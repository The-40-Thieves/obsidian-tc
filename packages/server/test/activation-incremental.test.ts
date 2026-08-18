// THE-461: recomputeActivation read the ENTIRE chunk_retrievals log on every pass. The exact ACT-R
// base-level equation Bi = ln(Σ tj^-d) is power-law and NOT time-separable, so a running aggregate
// cannot be cheaply re-evaluated at a new `now` — the incremental win is to recompute ONLY chunks
// with events past a persisted watermark (reading their full history exactly), not to change the
// math. A watermark of 0 makes the first pass a full one (self-bootstrapping).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { recomputeActivation } from "../src/experiential/activation";
import { openMemoryDb } from "./helpers";

const sql = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)), "utf8");

function edb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    { version: "20260723_001", sql: sql("20260723_001_activation_watermark.sql") },
  ]);
  return db;
}

let seq = 0;
function logRetrieval(db: Database, chunkId: string, retrievedAt: number): void {
  db.prepare("INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at) VALUES (?, ?, ?)").run(
    `ev_${seq++}`,
    chunkId,
    retrievedAt,
  );
}

function logAdvisoryPush(db: Database, chunkId: string, retrievedAt: number): void {
  db.prepare(
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type) VALUES (?, ?, ?, 'advisory')",
  ).run(`ev_${seq++}`, chunkId, retrievedAt);
}

function computedAt(db: Database, chunkId: string): number | null {
  const r = db
    .prepare("SELECT last_computed_at FROM vault_object_state WHERE object_id = ?")
    .get(chunkId) as { last_computed_at: number } | undefined;
  return r?.last_computed_at ?? null;
}

const watermark = (db: Database) =>
  (db.prepare("SELECT watermark FROM activation_state WHERE id = 1").get() as { watermark: number })
    .watermark;

describe("THE-461 incremental activation", () => {
  it("a full pass computes every chunk and advances the watermark to the log head", () => {
    const db = edb();
    logRetrieval(db, "a", 1000);
    logRetrieval(db, "b", 2000);
    logRetrieval(db, "c", 3000);

    const stats = recomputeActivation(db, 10_000);
    expect(stats.chunks).toBe(3);
    expect(computedAt(db, "a")).toBe(10_000);
    expect(watermark(db)).toBeGreaterThan(0); // bootstrapped to max rowid
  });

  it("an incremental pass touches only chunks with events past the watermark", () => {
    const db = edb();
    logRetrieval(db, "a", 1000);
    logRetrieval(db, "b", 2000);
    recomputeActivation(db, 10_000); // full seed
    const wmAfterSeed = watermark(db);

    // Two new events for chunk "b" and a new chunk "c"; "a" gets nothing.
    logRetrieval(db, "b", 11_000);
    logRetrieval(db, "c", 12_000);

    const stats = recomputeActivation(db, 20_000, { incremental: true });

    // Only the two chunks with new events are recomputed (touched at the new `now`).
    expect(stats.chunks).toBe(2);
    expect(computedAt(db, "b")).toBe(20_000);
    expect(computedAt(db, "c")).toBe(20_000);
    // "a" had no new event -> its cached score is untouched (still the seed pass's `now`).
    expect(computedAt(db, "a")).toBe(10_000);
    expect(watermark(db)).toBeGreaterThan(wmAfterSeed);
  });

  it("an incremental pass with no new events is a no-op", () => {
    const db = edb();
    logRetrieval(db, "a", 1000);
    recomputeActivation(db, 10_000);
    const stats = recomputeActivation(db, 20_000, { incremental: true });
    expect(stats.chunks).toBe(0);
    expect(computedAt(db, "a")).toBe(10_000); // untouched
  });

  it("incremental recompute of a chunk uses its FULL history, not just the new events", () => {
    const db = edb();
    // Two old retrievals for "a" at the seed.
    logRetrieval(db, "a", 1000);
    logRetrieval(db, "a", 2000);
    recomputeActivation(db, 10_000);
    const seedScore = db
      .prepare(
        "SELECT cached_activation_score s, frequency f FROM vault_object_state WHERE object_id = ?",
      )
      .get("a") as { s: number; f: number };
    expect(seedScore.f).toBe(2);

    // One new retrieval -> incremental recompute must see all THREE, so frequency becomes 3.
    logRetrieval(db, "a", 11_000);
    recomputeActivation(db, 20_000, { incremental: true });
    const after = db
      .prepare("SELECT frequency f FROM vault_object_state WHERE object_id = ?")
      .get("a") as { f: number };
    expect(after.f).toBe(3); // full history, not just the 1 new event
  });

  // THE-634 (adversarial review): the incremental branch's OWN query is two-layered — an inner
  // subquery finds chunks with ANY event past the watermark, an outer query reads their FULL
  // history — and only the earlier (non-incremental) branch had a test proving the surface_type
  // exclusion. An advisory-only "new event" can still trigger the inner subquery's watermark test
  // (it is a real row with a real rowid); this proves the outer query still excludes it from what
  // actually gets scored, so a chunk with ONLY a new advisory push past the watermark stays
  // untouched — not silently recomputed off a fake retrieval.
  it("THE-634: an advisory push past the watermark triggers the inner subquery but scores nothing new", () => {
    const db = edb();
    logRetrieval(db, "a", 1000);
    recomputeActivation(db, 10_000); // full seed
    const seed = db
      .prepare(
        "SELECT cached_activation_score s, frequency f, last_computed_at c FROM vault_object_state WHERE object_id = ?",
      )
      .get("a") as { s: number; f: number; c: number };

    // A RECENT advisory push for "a" — past the watermark, so the inner subquery picks "a" up.
    logAdvisoryPush(db, "a", 11_000);
    const stats = recomputeActivation(db, 20_000, { incremental: true });

    // "a" IS in byChunk (it has a real event in its history) so it IS recomputed — but off the
    // SAME history as the seed pass, since the advisory row is excluded from the outer read.
    expect(stats.chunks).toBe(1);
    const after = db
      .prepare(
        "SELECT cached_activation_score s, frequency f FROM vault_object_state WHERE object_id = ?",
      )
      .get("a") as { s: number; f: number };
    expect(after.f).toBe(seed.f); // still 1 — the advisory push added no real event
    // Same events, same `now` window relationship as they would be from a fresh full pass at the
    // seed's `now` — frequency is the sharpest signal since the advisory push, if counted, would
    // add a strictly more RECENT event and raise the score above the seed's.
    expect(after.s).toBeLessThanOrEqual(seed.s + 1e-9);

    // A chunk with ONLY an advisory event and no real history must never even reach the score
    // table — the same "pushed is not retrieved" invariant activation.test.ts pins for the
    // non-incremental branch.
    logAdvisoryPush(db, "pushed-only", 12_000);
    recomputeActivation(db, 21_000, { incremental: true });
    expect(
      db.prepare("SELECT 1 FROM vault_object_state WHERE object_id = 'pushed-only'").get(),
    ).toBeUndefined();
  });

  it("falls back to a full pass when the watermark table is absent (pre-migration db)", () => {
    const db = openMemoryDb();
    runMigrations(db, [
      { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
      { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    ]);
    logRetrieval(db, "a", 1000);
    logRetrieval(db, "b", 2000);
    // incremental requested, but no activation_state table -> must still compute everything, not crash
    const stats = recomputeActivation(db, 10_000, { incremental: true });
    expect(stats.chunks).toBe(2);
  });
});
