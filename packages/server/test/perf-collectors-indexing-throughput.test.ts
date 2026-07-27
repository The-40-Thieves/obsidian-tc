// THE-458: the last three perf gates the program named as missing — notes/s, embed tokens/s, and
// per-vault CPU/storage.
//
// Each throughput metric ships WITH its deterministic denominator, and that pairing is the point.
// A rate is only interpretable next to the count it divided: if notes silently stopped being
// indexed, `notes_per_s` would fall and read as a *throughput regression* — a performance story
// told about a correctness bug. The hard counts make that misreading impossible.
//
// ONE vault for the whole file, deliberately. The first draft built one per test, and vitest runs
// test FILES in parallel — so three extra vault builds landed alongside the existing perf-collector
// suites and starved them on the 2-core windows-latest runner:
//
//     storage    502ms -> 6487ms      indexing  759ms -> 7264ms
//     retrieval 1437ms -> 9074ms      (all three blew their 5s timeouts)
//
// Nothing was algorithmically slower; the CPU was simply gone. Same shape as THE-503, where an
// overlapping vitest run made the perf harness read 51% low while its gate still passed. Sharing is
// safe because no test here mutates the vault — they only read collected samples.
import { beforeAll, describe, expect, it } from "vitest";
import { collectIndexing } from "../eval/perf/collectors/indexing";
import { buildVault, type VaultCtx } from "../eval/perf/harness";
import type { MetricSample } from "../eval/perf/report";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("indexing throughput gates (THE-458)", () => {
  let vault: VaultCtx;
  let by: Map<string, MetricSample>;

  beforeAll(async () => {
    const t0 = performance.now();
    vault = await buildVault(SCENARIOS.small);
    by = new Map(collectIndexing(vault, performance.now() - t0).map((m) => [m.key, m]));
  }, 120_000);

  it("emits notes, tokens and the vault denominator, with NON-ZERO counts", () => {
    // The floor that matters. Every baselined value was measured first — an earlier draft read 0
    // for both counts because the harness was invoked wrongly, and baselining those zeros would
    // have produced three gates that could never fail (the vacuous-gate shape THE-601 fixed in
    // facts-check this morning).
    expect(by.get("index.notes_count")?.value).toBe(100); // scenario is `notes: 100`
    expect(by.get("embed.tokens")?.value).toBeGreaterThan(0);
    expect(by.get("harness.vault_count")?.value).toBe(1);
    expect(by.get("index.notes_per_s")?.value).toBeGreaterThan(0);
    expect(by.get("embed.tokens_per_s")?.value).toBeGreaterThan(0);
  });

  it("gates the COUNTS hard and the RATES warn", () => {
    // Matches the existing chunk_count/chunks_per_s split: counts are deterministic given the
    // seeded corpus and can block; rates are wall-clock on shared CI hardware and must not.
    for (const k of ["index.notes_count", "embed.tokens", "harness.vault_count"]) {
      expect(by.get(k)?.class, `${k} must be hard`).toBe("hard");
    }
    for (const k of ["index.notes_per_s", "embed.tokens_per_s"]) {
      expect(by.get(k)?.class, `${k} must be warn`).toBe("warn");
    }
  });

  it("counts tokens with PRODUCTION's estimator, not a harness-local one", async () => {
    // A throughput figure computed with a different estimator than the one deciding embed batching
    // would measure a quantity the server never acts on.
    const { estimateTokens } = await import("../src/search/chunk");
    expect(estimateTokens("abcd".repeat(10))).toBe(10); // 40 chars / 4
    // Tokens must exceed texts — every embedded text is at least one token, and most are many.
    expect(vault.provider.tokens).toBeGreaterThan(vault.provider.texts);
  });

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
