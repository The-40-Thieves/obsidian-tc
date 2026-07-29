// THE-48 — gap-detector pins: the flag rule (calibrated floor OR too few results), the
// nearest-context payload the cycle-close session files issues from, nearest-rank calibration
// percentiles, and the queries-file parser (JSONL or plain lines).
//
// THE-616: the injected search seam is now BATCH-shaped — detectGaps calls it once with every
// query string rather than looping a per-query call, so a caller can embed the whole batch in one
// provider.embed() round trip. `singleQuerySearch` adapts a plain per-query stub back to that
// shape for tests that don't care about batching.
//
// THE-644 item 1: detectGaps' output (GapReport) can now be persisted to experiential.db and read
// back — the read side the THE-611 MCP tool uses instead of recomputing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import {
  detectGaps,
  type GapBatchSearchFn,
  parseQueriesFile,
  persistGapReport,
  readLatestGapReport,
  scoreDistribution,
  singleQuerySearch,
} from "../src/experiential/gaps";
import { openMemoryDb } from "./helpers";

const hit = (path: string, score: number) => ({ path, score });

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

describe("detectGaps (THE-48)", () => {
  it("flags below-threshold, thin, and empty results; passes covered queries", async () => {
    const canned: Record<string, Array<{ path: string; score: number }>> = {
      covered: [hit("a.md", 0.05), hit("b.md", 0.04), hit("c.md", 0.03)],
      weak: [hit("a.md", 0.005), hit("b.md", 0.004)],
      thin: [hit("a.md", 0.09)],
      empty: [],
    };
    const report = await detectGaps(
      [
        { id: "covered", query: "covered" },
        { id: "weak", query: "weak" },
        { id: "thin", query: "thin" },
        { id: "empty", query: "empty" },
      ],
      singleQuerySearch(async (q) => canned[q] ?? []),
      { threshold: 0.016, minResults: 2 },
    );
    expect(report.total).toBe(4);
    expect(report.gaps).toBe(3);
    expect(report.gap_rate).toBeCloseTo(0.75);
    const byId = new Map(report.items.map((i) => [i.id, i]));
    expect(byId.get("covered")?.gap).toBe(false);
    expect(byId.get("weak")?.gap).toBe(true); // top below the calibrated floor
    expect(byId.get("thin")?.gap).toBe(true); // strong top but < min_results
    expect(byId.get("empty")?.gap).toBe(true);
    expect(byId.get("empty")?.top_score).toBeNull();
    // nearest context rides along for issue drafting
    expect(byId.get("covered")?.nearest).toHaveLength(3);
    expect(byId.get("covered")?.nearest[0]?.path).toBe("a.md");
  });

  it("THE-616: batches the search seam — calls it exactly once with every query", async () => {
    const calls: string[][] = [];
    const search: GapBatchSearchFn = async (queries) => {
      calls.push(queries);
      return queries.map((q) => [hit(`${q}.md`, 0.5)]);
    };
    const queries = [
      { id: "q1", query: "alpha" },
      { id: "q2", query: "beta" },
      { id: "q3", query: "gamma" },
    ];
    await detectGaps(queries, search, { threshold: 0.1, minResults: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("THE-616: preserves input order in `items` regardless of how the batch resolves", async () => {
    // The batched search returns each query's hits scored so a naive "sort by score" or
    // "gaps first" reshuffle would be visible; items must come back in INPUT order.
    const search: GapBatchSearchFn = async (queries) =>
      queries.map((q, i) => [hit(`${q}.md`, (i + 1) / 10)]);
    const queries = [
      { id: "z", query: "z-query" },
      { id: "a", query: "a-query" },
      { id: "m", query: "m-query" },
    ];
    const report = await detectGaps(queries, search, { threshold: 0, minResults: 1 });
    expect(report.items.map((i) => i.id)).toEqual(["z", "a", "m"]);
  });

  it("does not call search at all for an empty query list", async () => {
    let called = false;
    const search: GapBatchSearchFn = async () => {
      called = true;
      return [];
    };
    const report = await detectGaps([], search, {});
    expect(called).toBe(false);
    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });
});

describe("scoreDistribution", () => {
  it("nearest-rank percentiles over the sample", () => {
    const scores = Array.from({ length: 100 }, (_, i) => (i + 1) / 100); // 0.01..1.00
    const d = scoreDistribution(scores);
    expect(d.n).toBe(100);
    expect(d.min).toBeCloseTo(0.01);
    expect(d.p5).toBeCloseTo(0.05);
    expect(d.p10).toBeCloseTo(0.1);
    expect(d.p25).toBeCloseTo(0.25);
    expect(d.median).toBeCloseTo(0.5);
    // THE-617 item 1 — extended past the median (a hard prerequisite for THE-631), reusing the
    // same at() nearest-rank helper so every percentile shares one rounding rule.
    expect(d.p75).toBeCloseTo(0.75);
    expect(d.p90).toBeCloseTo(0.9);
    expect(d.p95).toBeCloseTo(0.95);
    expect(scoreDistribution([]).n).toBe(0);
  });
});

describe("parseQueriesFile", () => {
  it("accepts JSONL and plain lines, skips comments and blanks", () => {
    const raw = [
      "# comment",
      '{"id":"a","query":"first query"}',
      "",
      "a plain query line",
      '{"query":"no id"}',
      "{not json",
    ].join("\n");
    const { queries: qs, warnings } = parseQueriesFile(raw);
    expect(qs).toHaveLength(4);
    expect(qs[0]).toEqual({ id: "a", query: "first query" });
    expect(qs[1]?.query).toBe("a plain query line");
    expect(qs[2]?.query).toBe("no id");
    expect(qs[2]?.id).toMatch(/^q\d+$/);
    expect(qs[3]?.query).toBe("{not json"); // malformed JSON degrades to a raw line, not dropped
    // THE-617 item 2 — a line that LOOKS like JSON but fails to parse is reported, not just
    // silently degraded; the warning names the 1-indexed line number.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^line 6:/);
  });

  it("does not fail hard on a malformed file — the rest of the lines still parse", () => {
    const raw = ['{"query":"good one"}', "{also not json", '{"query":"good two"}'].join("\n");
    const { queries, warnings } = parseQueriesFile(raw);
    expect(queries.map((q) => q.query)).toEqual(["good one", "{also not json", "good two"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^line 2:/);
  });
});

describe("persistGapReport / readLatestGapReport (THE-644 item 1)", () => {
  it("round-trips a report, including nested `nearest` and item order", async () => {
    const edb = edb0();
    const report = await detectGaps(
      [
        { id: "q1", query: "one" },
        { id: "q2", query: "two" },
      ],
      singleQuerySearch(async (q) => (q === "one" ? [hit("a.md", 0.5)] : [])),
      { threshold: 0.1, minResults: 1 },
    );
    persistGapReport(edb, report, { vaultId: "main", computedAt: 1_000 });
    const stored = readLatestGapReport(edb, "main");
    expect(stored).not.toBeNull();
    expect(stored?.vault_id).toBe("main");
    expect(stored?.computed_at).toBe(1_000);
    expect(stored?.threshold).toBe(0.1);
    expect(stored?.total).toBe(2);
    expect(stored?.gaps).toBe(1);
    expect(stored?.items.map((i) => i.id)).toEqual(["q1", "q2"]);
    expect(stored?.items[0]?.nearest).toEqual([{ path: "a.md", score: 0.5 }]);
  });

  it("returns null when no report has ever been persisted for a vault", () => {
    const edb = edb0();
    expect(readLatestGapReport(edb, "unknown-vault")).toBeNull();
  });

  it("scopes by vault_id and reads back the LATEST pass, not the first", async () => {
    const edb = edb0();
    const empty = await detectGaps(
      [],
      singleQuerySearch(async () => []),
      {},
    );
    persistGapReport(edb, { ...empty, total: 1, gaps: 0 }, { vaultId: "main", computedAt: 1_000 });
    persistGapReport(edb, { ...empty, total: 2, gaps: 1 }, { vaultId: "main", computedAt: 2_000 });
    persistGapReport(
      edb,
      { ...empty, total: 99, gaps: 99 },
      { vaultId: "other", computedAt: 3_000 },
    );
    const stored = readLatestGapReport(edb, "main");
    expect(stored?.computed_at).toBe(2_000);
    expect(stored?.total).toBe(2);
  });
});
