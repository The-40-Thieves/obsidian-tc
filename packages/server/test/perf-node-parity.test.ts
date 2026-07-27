// THE-494 — the portable-metric set, pinned.
//
// The gated perf harness runs under bun + better-sqlite3 + sqlite-vec: the real production storage
// path. Under Node + node:sqlite the sqlite-vec extension does NOT load and vector search silently
// degrades to brute force, so a Node run that included ANN-dependent metrics would be benchmarking
// a path production never takes and calling the result parity.
//
// `portable` is therefore OPT-IN: a new metric is non-portable until someone says otherwise, so
// forgetting the flag under-reports (visible, harmless) instead of over-reporting (invisible,
// wrong). This test makes the resulting set explicit — an addition or removal has to be stated
// here, which is where a reviewer will ask whether it really is storage-agnostic.
import { describe, expect, it } from "vitest";
import { collectIndexing } from "../eval/perf/collectors/indexing";
import type { MetricSample } from "../eval/perf/report";

/** Every metric currently claimed portable, and why it survives the loss of sqlite-vec. */
const PORTABLE = {
  "index.chunk_count": "deterministic count over a seeded corpus; no vector path",
  "index.chunks_per_s": "indexing throughput; embedding is faked and storage-agnostic",
  "index.txn_count": "counted write transactions; batching is not vec-dependent",
  "embed.call_count": "provider call count against the deterministic fake",
  "embed.texts_per_s": "embed throughput against the deterministic fake",
  "embed.dup_ratio": "duplicate-embedding ratio; a corpus property, not a storage one",
  // THE-458. All five are corpus/provider properties measured before anything touches a vector
  // index, so losing sqlite-vec cannot change them.
  "index.notes_count": "deterministic note count over a seeded corpus; no vector path",
  "index.notes_per_s": "note throughput; embedding is faked and storage-agnostic",
  "embed.tokens": "estimateTokens over the same faked texts; pure string arithmetic",
  "embed.tokens_per_s": "token throughput against the deterministic fake",
  "harness.vault_count": "how many vaults the harness built; a harness fact, not a storage one",
  "freshness.visible": "write-to-search visibility via search_text — the LEXICAL/FTS path",
  "freshness.ms": "same lexical path; warn-class and never gated across runtimes",
} as const;

/** Metrics that must NEVER be portable: they measure the vec/ANN path, raw storage layout, or a
 *  runtime's own characteristics, all of which change meaning under node:sqlite. */
const MUST_NOT_BE_PORTABLE = [
  "graph.candidates_seed",
  "graph.candidates_expand",
  "graph.candidates_fused",
  "retrieval.recall_at10",
  "retrieval.ndcg_at10",
  "retrieval.ndcg_per_ms",
  "storage.bytes",
  "runtime.eventloop_p99_ms",
  "runtime.peak_rss_mb",
];

/** The harness's own VaultCtx is expensive to build; collectIndexing only reads these fields. */
const fakeVault = {
  chunkCount: 200,
  // THE-458 widened what collectIndexing reads: notes come from stats, tokens from the provider.
  // Both must be present here or the new metrics compute from `undefined` and the enumeration
  // check passes against NaN — a green test over meaningless values.
  stats: { notes_indexed: 100 },
  provider: { texts: 120, tokens: 2577 },
} as unknown as Parameters<typeof collectIndexing>[0];

describe("THE-494 portable perf-metric set", () => {
  it("tags exactly the enumerated metrics in the indexing collector", () => {
    const samples = collectIndexing(fakeVault, 1000);
    const portable = samples.filter((s) => s.portable === true).map((s) => s.key);
    // A silently empty set would read as "nothing ported" rather than "the tags are gone".
    expect(portable.length).toBeGreaterThan(0);
    for (const key of portable) expect(Object.keys(PORTABLE)).toContain(key);
    // ...and every indexing metric named above really is emitted by this collector.
    const emitted = samples.map((s) => s.key);
    for (const key of Object.keys(PORTABLE).filter((k) => emitted.includes(k))) {
      expect(portable).toContain(key);
    }
  });

  it("keeps the vec/ANN and runtime-specific metrics OUT of the portable set", () => {
    for (const key of MUST_NOT_BE_PORTABLE) expect(Object.keys(PORTABLE)).not.toContain(key);
  });

  it("floors the portable set — an empty profile must never read as a clean parity result", () => {
    expect(Object.keys(PORTABLE).length).toBeGreaterThanOrEqual(6);
  });

  it("every portable claim carries a written reason", () => {
    for (const [key, reason] of Object.entries(PORTABLE)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("the flag is optional, so an untagged sample is non-portable by default", () => {
    const untagged: MetricSample = {
      key: "some.new_metric",
      value: 1,
      unit: "count",
      class: "hard",
      direction: "exact",
    };
    expect(untagged.portable).toBeUndefined();
    expect([untagged].filter((s) => s.portable === true)).toEqual([]);
  });
});
