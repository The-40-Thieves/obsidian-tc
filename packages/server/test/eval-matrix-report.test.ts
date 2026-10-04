// The part-2 matrix report: pairing by id, the preregistered win / loss / tie rule against the
// preregistered MDE, Benjamini-Hochberg across the arms of one corpus, and the inert-arm signal.
// Synthetic artifacts only; no corpus text and no run is needed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Artifact,
  baselineSide,
  discover,
  formatCorpusTable,
  graphSide,
  judge,
  pairSides,
  reportCorpus,
} from "../eval/corpora/matrix-report";
import type { QueryMetrics } from "../eval/metrics";

const m = (ndcg: number, over: Partial<QueryMetrics> = {}): QueryMetrics => ({
  query_id: "q",
  recall_at_10: ndcg,
  mrr_at_10: ndcg,
  ndcg_at_10: ndcg,
  bridge_recall: 0,
  bridge_ndcg_at_10: null,
  expected_found_in_top10: 1,
  expected_total: 1,
  bridge_satisfied: false,
  result_paths_unique: 10,
  leaked_paths: null,
  ...over,
});

/** Artifact whose graph side is `graph[i]` and whose dense side is `base[i]`. */
const artifact = (base: number[], graph: number[]): Artifact => ({
  perQuery: graph.map((g, i) => ({ id: `q${i}`, baseline: m(base[i] ?? 0), graph: m(g) })),
});

const N = 60;
const flat = Array.from({ length: N }, (_, i) => 0.5 + (i % 5) * 0.1);
const shifted = (d: number): number[] => flat.map((x, i) => x + (i % 2 === 0 ? d : d * 0.5));

describe("judge: the preregistered rule", () => {
  it("calls a significant delta at or above the MDE a win, and the mirror a loss", () => {
    expect(judge(0.06, 0.001, true, 0.053).verdict).toBe("WIN");
    expect(judge(-0.06, 0.001, true, 0.053).verdict).toBe("LOSS");
  });
  it("calls a significant delta under the MDE a tie and marks it", () => {
    expect(judge(0.03, 0.01, true, 0.053)).toEqual({ verdict: "TIE", subMdeSignificant: true });
  });
  it("calls an MDE-sized delta that is not BH-significant a tie", () => {
    expect(judge(0.08, 0.04, false, 0.053).verdict).toBe("TIE");
  });
});

describe("pairSides", () => {
  it("pairs by id and reports B minus A", () => {
    const r = pairSides(artifact(flat, flat), graphSide, artifact(flat, shifted(0.1)), graphSide);
    expect(r.n).toBe(N);
    expect(r.ndcg.mean).toBeGreaterThan(0.07);
    expect(r.ndcg.p).toBeLessThan(0.01);
    expect(r.changed).toBe(N);
  });
  it("ignores queries only one artifact holds", () => {
    const a = artifact(flat, flat);
    const b = artifact(flat, flat);
    b.perQuery.push({ id: "extra", baseline: m(1), graph: m(1) });
    expect(pairSides(a, graphSide, b, graphSide).n).toBe(N);
  });
  it("throws when nothing overlaps", () => {
    const b: Artifact = { perQuery: [{ id: "zzz", baseline: m(1), graph: m(1) }] };
    expect(() => pairSides(artifact(flat, flat), graphSide, b, graphSide)).toThrow(/overlapping/);
  });
  it("reports a byte-identical arm as changing no query", () => {
    const r = pairSides(artifact(flat, flat), graphSide, artifact(flat, flat), graphSide);
    expect(r.changed).toBe(0);
    expect(r.ndcg.p).toBe(1);
  });
  it("scores the bridge metric over the queries that declare bridge notes only", () => {
    const a = artifact(flat, flat);
    const b = artifact(flat, flat);
    a.perQuery[0] = { id: "q0", baseline: m(0.5), graph: m(0.5, { bridge_ndcg_at_10: 0.2 }) };
    b.perQuery[0] = { id: "q0", baseline: m(0.5), graph: m(0.5, { bridge_ndcg_at_10: 0.6 }) };
    const r = pairSides(a, graphSide, b, graphSide);
    expect(r.bridgeNdcg?.n).toBe(1);
    expect(r.bridgeNdcg?.mean).toBeCloseTo(0.4, 10);
  });
});

describe("reportCorpus", () => {
  const control = artifact(
    flat,
    flat.map((x) => Math.min(1, x + 0.08)),
  );
  const winner = artifact(
    flat,
    shifted(0.2)
      .map((x) => Math.min(1, x))
      .map((x) => x + 0.0),
  );
  const same = artifact(
    flat,
    control.perQuery.map((q) => q.graph.ndcg_at_10),
  );
  const tiny = artifact(
    flat,
    control.perQuery.map((q, i) => q.graph.ndcg_at_10 + (i % 2 === 0 ? 0.01 : 0)),
  );

  const rep = reportCorpus("c", 0.05, control, [
    { arm: "winner", artifact: winner },
    { arm: "same", artifact: same },
    { arm: "tiny", artifact: tiny },
  ]);

  it("labels the default stack against its own dense side", () => {
    expect(rep.defaultStack?.ndcg.mean).toBeCloseTo(0.08, 6);
    expect(rep.defaultStack?.verdict).toBe("WIN");
    const own = pairSides(control, baselineSide, control, graphSide);
    expect(rep.defaultStack?.ndcg.mean).toBeCloseTo(own.ndcg.mean, 12);
  });
  it("gives each arm its own row with the rule applied and the inert arm flagged", () => {
    const by = new Map(rep.arms.map((a) => [a.arm, a]));
    expect(by.get("winner")?.verdict).toBe("WIN");
    expect(by.get("same")?.verdict).toBe("TIE");
    expect(by.get("same")?.result.changed).toBe(0);
    expect(by.get("tiny")?.verdict).toBe("TIE");
  });
  it("renders one table row per arm plus the default stack", () => {
    const table = formatCorpusTable(rep);
    expect(table.trim().split("\n")).toHaveLength(2 + 1 + 3);
    expect(table).toContain("| winner |");
    expect(table).toContain("| default stack, graph vs dense |");
  });
});

describe("discover", () => {
  it("groups <corpus>--<arm>.json files by corpus and ignores everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-"));
    try {
      for (const f of ["a--default.json", "a--graph-stream.json", "b--default.json", "notes.txt"])
        writeFileSync(join(dir, f), "{}");
      const found = discover(dir);
      expect([...found.keys()].sort()).toEqual(["a", "b"]);
      expect([...(found.get("a")?.keys() ?? [])].sort()).toEqual(["default", "graph-stream"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
