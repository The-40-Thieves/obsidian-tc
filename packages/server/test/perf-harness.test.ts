import { describe, expect, it } from "vitest";
import { buildVault, countingDatabase, quantiles } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";
import { perfTimeout } from "./perf-timeouts";

describe("perf harness synthetic vault", () => {
  it(
    "is deterministic: same scenario -> identical chunk count + dup structure",
    async () => {
      const a = await buildVault(SCENARIOS.small);
      const b = await buildVault(SCENARIOS.small);
      expect(a.chunkCount).toBe(b.chunkCount);
      expect(a.provider.texts).toBe(b.provider.texts); // unique bodies embedded — identical
      expect(a.stats.chunks_upserted).toBe(b.stats.chunks_upserted);
      a.cleanup();
      b.cleanup();
    },
    perfTimeout(5_000),
  );

  it(
    "embeds fewer texts than chunks because of the duplicate-body set",
    async () => {
      const v = await buildVault(SCENARIOS.small);
      expect(v.provider.texts).toBeLessThan(v.chunkCount);
      expect(v.provider.texts).toBeGreaterThan(0);
      v.cleanup();
    },
    perfTimeout(5_000),
  );

  it("quantiles() returns p50<=p95<=p99", () => {
    const q = quantiles([5, 1, 4, 2, 3, 9, 7, 8, 6, 10]);
    expect(q.p50).toBeLessThanOrEqual(q.p95);
    expect(q.p95).toBeLessThanOrEqual(q.p99);
  });

  it(
    "excludes lazy schema setup from indexVault's write-transaction count (THE-503)",
    async () => {
      const v = await buildVault(SCENARIOS.small);
      try {
        const runtimeSchemas = v.db
          .prepare(
            `SELECT version FROM schema_migrations
             WHERE version IN (
               '20260519_002_vec_chunks_32',
               '20260702_002_notes_fts',
               '20260710_001_chunk_fts'
             )
             ORDER BY version`,
          )
          .all() as Array<{ version: string }>;

        // These schemas each use applySchemaMigration's BEGIN IMMEDIATE on a cold database. They
        // are harness setup, not indexVault batching, and therefore must be outside the counter.
        expect(runtimeSchemas.map((row) => row.version)).toEqual([
          "20260519_002_vec_chunks_32",
          "20260702_002_notes_fts",
          "20260710_001_chunk_fts",
        ]);
        expect(v.writeTxnCount).toBe(3);
      } finally {
        v.cleanup();
      }
    },
    perfTimeout(5_000),
  );
});

describe("countingDatabase()", () => {
  it('counts exec("BEGIN") calls and still delegates every operation to the base db', () => {
    const execCalls: string[] = [];
    const fakeStatement = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    const base = {
      exec: (sql: string) => {
        execCalls.push(sql);
      },
      prepare: () => fakeStatement,
    };
    const wrapped = countingDatabase(base);

    wrapped.exec("BEGIN");
    wrapped.exec("COMMIT");
    wrapped.exec("BEGIN");
    wrapped.exec("SELECT 1");

    expect(wrapped.writeTxnCount).toBe(2);
    expect(execCalls).toEqual(["BEGIN", "COMMIT", "BEGIN", "SELECT 1"]);
    expect(wrapped.prepare("SELECT 1")).toBe(fakeStatement);
  });

  // THE-585 (#5) moved the index write paths to BEGIN IMMEDIATE. The counter previously tested
  // `sql === "BEGIN"`, so it counted NONE of them — and because index.txn_count is lower-is-better,
  // a silent zero reads as a triumphant improvement instead of a broken metric. Pin every mode.
  it("counts a transaction start in any mode, not only the bare BEGIN", () => {
    const base = {
      exec: () => {},
      prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
    };
    for (const sql of [
      "BEGIN",
      "BEGIN IMMEDIATE",
      "BEGIN EXCLUSIVE",
      "begin immediate",
      "  BEGIN  ",
    ]) {
      const wrapped = countingDatabase(base);
      wrapped.exec(sql);
      expect(wrapped.writeTxnCount, `${sql} should count as a write transaction`).toBe(1);
    }
    // ...but nothing else does. SAVEPOINT opens a transaction too, yet it is nested work inside one
    // already counted; counting it would double-count THE-573's savepoint paths.
    for (const sql of ["COMMIT", "ROLLBACK", "SELECT 1", "SAVEPOINT sp_1", "BEGINNING"]) {
      const wrapped = countingDatabase(base);
      wrapped.exec(sql);
      expect(wrapped.writeTxnCount, `${sql} must not count`).toBe(0);
    }
  });
});
