// THE-48 — gap-detector pins: the flag rule (calibrated floor OR too few results), the
// nearest-context payload the cycle-close session files issues from, nearest-rank calibration
// percentiles, and the queries-file parser (JSONL or plain lines).
import { describe, expect, it } from "vitest";
import { detectGaps, parseQueriesFile, scoreDistribution } from "../src/experiential/gaps";

const hit = (path: string, score: number) => ({ path, score });

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
      async (q) => canned[q] ?? [],
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
    const qs = parseQueriesFile(raw);
    expect(qs).toHaveLength(4);
    expect(qs[0]).toEqual({ id: "a", query: "first query" });
    expect(qs[1]?.query).toBe("a plain query line");
    expect(qs[2]?.query).toBe("no id");
    expect(qs[2]?.id).toMatch(/^q\d+$/);
    expect(qs[3]?.query).toBe("{not json"); // malformed JSON degrades to a raw line
  });
});
