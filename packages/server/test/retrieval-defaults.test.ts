// ADR-0007 class (b): retrieval parameters derived from measured per-vault index statistics.
// This file pins the PURE half: the precedence matrix and the derivation function. The wiring
// (every call site, flag off) is pinned by retrieval-defaults-parity.test.ts; the stats reader by
// vault-index-stats.test.ts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNN_MIN_SIM,
  DEFAULT_RRF_K,
  DEFAULT_SEED_COUNT,
  deriveRrfK,
  RRF_K_MAX,
  RRF_K_MIN,
  resolveFanOutRrfK,
  resolveRetrievalDefaults,
} from "../src/search/retrieval-defaults";
import type { VaultIndexStats } from "../src/search/vault-index-stats";

const stats = (over: Partial<VaultIndexStats> = {}): VaultIndexStats => ({
  vaultId: "v",
  chunkCount: 5000,
  noteCount: 1000,
  edgeCount: 4000,
  avgChunksPerNote: 5,
  edgesPerNote: 4,
  ...over,
});

describe("constants", () => {
  it("pin the values main shipped (flag-off parity hangs on these)", () => {
    expect(DEFAULT_RRF_K).toBe(10);
    expect(DEFAULT_KNN_MIN_SIM).toBe(0);
    expect(DEFAULT_SEED_COUNT).toBe(30);
  });
});

describe("deriveRrfK — bounds", () => {
  it("reproduces the shipped constant at the pool depth it was tuned at (>= 30 chunks)", () => {
    for (const chunkCount of [30, 31, 100, 13_746, 10_000_000]) {
      expect(deriveRrfK(stats({ chunkCount }))).toBe(DEFAULT_RRF_K);
    }
  });

  it("shrinks k for a vault smaller than the stream pool (tiny vault)", () => {
    expect(deriveRrfK(stats({ chunkCount: 12 }))).toBe(4);
    expect(deriveRrfK(stats({ chunkCount: 6 }))).toBe(2);
  });

  it("never leaves [RRF_K_MIN, RRF_K_MAX], including one-chunk vaults and absurd seedCounts", () => {
    for (const chunkCount of [1, 2, 3, 29, 30, 1e9]) {
      for (const seed of [1, 5, 30, 90, 1e6]) {
        const k = deriveRrfK(stats({ chunkCount }), seed);
        expect(k).not.toBeNull();
        expect(k as number).toBeGreaterThanOrEqual(RRF_K_MIN);
        expect(k as number).toBeLessThanOrEqual(RRF_K_MAX);
        expect(Number.isInteger(k)).toBe(true);
      }
    }
  });

  it("scales with a deeper stream pool (operator-raised seedCount) on a big vault", () => {
    expect(deriveRrfK(stats({ chunkCount: 50_000 }), 60)).toBe(20);
    expect(deriveRrfK(stats({ chunkCount: 50_000 }), 600)).toBe(RRF_K_MAX);
  });
});

describe("deriveRrfK — monotonic where claimed", () => {
  it("is non-decreasing in chunkCount", () => {
    let prev = 0;
    for (let n = 1; n <= 200; n++) {
      const k = deriveRrfK(stats({ chunkCount: n })) as number;
      expect(k).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
  });

  it("is non-decreasing in seedCount", () => {
    let prev = 0;
    for (let s = 1; s <= 300; s++) {
      const k = deriveRrfK(stats({ chunkCount: 100_000 }), s) as number;
      expect(k).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
  });

  it("does NOT depend on graph density or chunk shape: no measurement shows it should", () => {
    const base = deriveRrfK(stats());
    for (const edgeCount of [0, 10, 1e6]) {
      for (const edgesPerNote of [0, 0.01, 4, 500]) {
        expect(deriveRrfK(stats({ edgeCount, edgesPerNote }))).toBe(base);
      }
    }
    expect(deriveRrfK(stats({ noteCount: 1, avgChunksPerNote: 5000 }))).toBe(base);
  });
});

describe("deriveRrfK — unusable stats fall back (null => caller keeps the constant)", () => {
  const bad: Array<[string, Parameters<typeof deriveRrfK>[0]]> = [
    ["null", null],
    ["undefined", undefined],
    ["zero chunks", stats({ chunkCount: 0 })],
    ["negative chunks", stats({ chunkCount: -4 })],
    ["NaN chunks", stats({ chunkCount: Number.NaN })],
    ["Infinity chunks", stats({ chunkCount: Number.POSITIVE_INFINITY })],
    ["missing chunkCount", {} as unknown as VaultIndexStats],
    ["string chunkCount", { chunkCount: "30" } as unknown as VaultIndexStats],
  ];
  for (const [name, s] of bad) {
    it(name, () => expect(deriveRrfK(s)).toBeNull());
  }

  it("ignores a non-finite / non-positive seedCount instead of propagating it", () => {
    for (const seed of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
      expect(deriveRrfK(stats({ chunkCount: 20 }), seed)).toBe(
        deriveRrfK(stats({ chunkCount: 20 })),
      );
    }
  });
});

describe("resolveRetrievalDefaults — precedence: call > config > derived (flag) > constant", () => {
  const tiny = stats({ chunkCount: 9 }); // derives to 3
  const derivedK = 3;

  it("flag absent: a stats-bearing resolve still returns the constant, source=default", () => {
    expect(resolveRetrievalDefaults(tiny, {}).rrfK).toEqual({ value: 10, source: "default" });
    expect(resolveRetrievalDefaults(tiny, undefined).rrfK).toEqual({
      value: 10,
      source: "default",
    });
  });

  it("flag explicitly false: constant", () => {
    expect(resolveRetrievalDefaults(tiny, { derivedDefaults: false }).rrfK).toEqual({
      value: 10,
      source: "default",
    });
  });

  it("flag true: derived wins over the constant", () => {
    expect(resolveRetrievalDefaults(tiny, { derivedDefaults: true }).rrfK).toEqual({
      value: derivedK,
      source: "derived",
    });
  });

  it("flag true, stats missing/unusable: constant, source=default (never a fabricated value)", () => {
    for (const s of [
      null,
      undefined,
      stats({ chunkCount: 0 }),
      stats({ chunkCount: Number.NaN }),
    ]) {
      expect(resolveRetrievalDefaults(s, { derivedDefaults: true }).rrfK).toEqual({
        value: 10,
        source: "default",
      });
    }
  });

  it("explicit config beats derived, flag on — even when it equals the constant", () => {
    expect(resolveRetrievalDefaults(tiny, { derivedDefaults: true, rrfK: 60 }).rrfK).toEqual({
      value: 60,
      source: "config",
    });
    expect(resolveRetrievalDefaults(tiny, { derivedDefaults: true, rrfK: 10 }).rrfK).toEqual({
      value: 10,
      source: "config",
    });
  });

  it("explicit config beats the constant, flag off", () => {
    expect(resolveRetrievalDefaults(tiny, { rrfK: 25 }).rrfK).toEqual({
      value: 25,
      source: "config",
    });
  });

  it("per-call arg beats explicit config and derived", () => {
    expect(
      resolveRetrievalDefaults(tiny, { derivedDefaults: true, rrfK: 60 }, { rrfK: 7 }).rrfK,
    ).toEqual({ value: 7, source: "call" });
    expect(resolveRetrievalDefaults(null, undefined, { rrfK: 7 }).rrfK).toEqual({
      value: 7,
      source: "call",
    });
  });

  it("call.seedCount feeds the derivation (the pool actually searched)", () => {
    const big = stats({ chunkCount: 100_000 });
    expect(
      resolveRetrievalDefaults(big, { derivedDefaults: true }, { seedCount: 60 }).rrfK,
    ).toEqual({ value: 20, source: "derived" });
  });

  it("knnMinSim is never derived: no stat supports it — call > config > constant", () => {
    expect(resolveRetrievalDefaults(tiny, { derivedDefaults: true }).knnMinSim).toEqual({
      value: 0,
      source: "default",
    });
    expect(resolveRetrievalDefaults(tiny, { knnMinSim: 0.8 }).knnMinSim).toEqual({
      value: 0.8,
      source: "config",
    });
    expect(
      resolveRetrievalDefaults(tiny, { knnMinSim: 0.8 }, { knnMinSim: 0.5 }).knnMinSim,
    ).toEqual({ value: 0.5, source: "call" });
  });
});

describe("resolveFanOutRrfK — cross-list fusion has no per-vault stat", () => {
  it("call > constant; never derived", () => {
    expect(resolveFanOutRrfK()).toEqual({ value: 10, source: "default" });
    expect(resolveFanOutRrfK(33)).toEqual({ value: 33, source: "call" });
  });
});
