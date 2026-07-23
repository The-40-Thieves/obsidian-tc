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
});
