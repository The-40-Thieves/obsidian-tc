import { describe, expect, it } from "vitest";
import { buildVault, countingDatabase, quantiles } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("perf harness synthetic vault", () => {
  it("is deterministic: same scenario -> identical chunk count + dup structure", async () => {
    const a = await buildVault(SCENARIOS.small);
    const b = await buildVault(SCENARIOS.small);
    expect(a.chunkCount).toBe(b.chunkCount);
    expect(a.provider.texts).toBe(b.provider.texts); // unique bodies embedded — identical
    expect(a.stats.chunks_upserted).toBe(b.stats.chunks_upserted);
    a.cleanup();
    b.cleanup();
  });

  it("embeds fewer texts than chunks because of the duplicate-body set", async () => {
    const v = await buildVault(SCENARIOS.small);
    expect(v.provider.texts).toBeLessThan(v.chunkCount);
    expect(v.provider.texts).toBeGreaterThan(0);
    v.cleanup();
  });

  it("quantiles() returns p50<=p95<=p99", () => {
    const q = quantiles([5, 1, 4, 2, 3, 9, 7, 8, 6, 10]);
    expect(q.p50).toBeLessThanOrEqual(q.p95);
    expect(q.p95).toBeLessThanOrEqual(q.p99);
  });

  it("exposes a real write-transaction count from indexVault's own batching (THE-503)", async () => {
    const v = await buildVault(SCENARIOS.small);
    expect(v.writeTxnCount).toBeGreaterThan(0);
    // 100 notes fit in one THE-500 batch flush (default 100 notes / 8MiB) -> one write txn,
    // nowhere near "one per chunk" (200 chunks).
    expect(v.writeTxnCount).toBeLessThan(v.chunkCount);
    v.cleanup();
  });
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
