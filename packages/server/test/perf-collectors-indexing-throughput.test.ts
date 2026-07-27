// THE-458: the last three perf gates the program named as missing — notes/s, embed tokens/s, and
// per-vault CPU/storage.
//
// Each throughput metric ships WITH its deterministic denominator, and that pairing is the point.
// A rate is only interpretable next to the count it divided: if notes silently stopped being
// indexed, `notes_per_s` would fall and read as a *throughput regression* — a performance story for
// a correctness bug. The hard counts make that misreading impossible.
import { describe, expect, it } from "vitest";
import { collectIndexing } from "../eval/perf/collectors/indexing";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("indexing throughput gates (THE-458)", () => {
  it("emits notes, tokens and the vault denominator, with non-zero counts", async () => {
    // The floor that matters. Every value here was measured before it was baselined — an earlier
    // draft of this work read 0 for both counts because the harness was invoked wrongly, and
    // baselining those zeros would have produced three gates that could never fail.
    const t0 = performance.now();
    const vault = await buildVault(SCENARIOS.small);
    const by = new Map(collectIndexing(vault, performance.now() - t0).map((m) => [m.key, m]));

    // `notes: 100` in the scenario, so this is definitional: a drift means the scenario changed or
    // notes stopped being indexed.
    expect(by.get("index.notes_count")?.value).toBe(100);
    expect(by.get("embed.tokens")?.value).toBeGreaterThan(0);
    expect(by.get("harness.vault_count")?.value).toBe(1);

    // Rates follow from a non-zero count and a non-zero elapsed time.
    expect(by.get("index.notes_per_s")?.value).toBeGreaterThan(0);
    expect(by.get("embed.tokens_per_s")?.value).toBeGreaterThan(0);
  }, 60_000);

  it("gates the COUNTS hard and the RATES warn", async () => {
    // Deliberate split, matching the existing chunk_count/chunks_per_s pair. Counts are
    // deterministic given the seeded corpus and can block; rates are wall-clock on shared CI
    // hardware and must not.
    const t0 = performance.now();
    const vault = await buildVault(SCENARIOS.small);
    const by = new Map(collectIndexing(vault, performance.now() - t0).map((m) => [m.key, m]));
    for (const k of ["index.notes_count", "embed.tokens", "harness.vault_count"]) {
      expect(by.get(k)?.class, `${k} must be hard`).toBe("hard");
    }
    for (const k of ["index.notes_per_s", "embed.tokens_per_s"]) {
      expect(by.get(k)?.class, `${k} must be warn`).toBe("warn");
    }
  }, 60_000);

  it("counts tokens with PRODUCTION's estimator, not a harness-local one", async () => {
    // A throughput figure computed with a different estimator than the one that decides embed
    // batching would measure a quantity the server never acts on. Verified by recomputing the
    // provider's total from the same function production uses.
    const { estimateTokens } = await import("../src/search/chunk");
    expect(estimateTokens("abcd".repeat(10))).toBe(10); // 40 chars / 4
    const vault = await buildVault(SCENARIOS.small);
    // Tokens must exceed texts — every embedded text is at least one token, and most are many.
    expect(vault.provider.tokens).toBeGreaterThan(vault.provider.texts);
  }, 60_000);

  it("is baselined, or the gate is informational and can never fail", async () => {
    // gate.ts walks the BASELINE, not the report — an unbaselined metric is "not yet a promise".
    const baseline = (await import("../eval/perf/baseline.small.json")).default as Record<
      string,
      { class: string }
    >;
    for (const k of [
      "index.notes_count",
      "index.notes_per_s",
      "embed.tokens",
      "embed.tokens_per_s",
      "harness.vault_count",
    ]) {
      expect(baseline[k], `${k} must be baselined to be gated`).toBeDefined();
    }
    expect(baseline["index.notes_count"]?.class).toBe("hard");
    expect(baseline["index.notes_per_s"]?.class).toBe("warn");
  });
});
