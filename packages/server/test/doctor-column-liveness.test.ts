// derived.column-liveness (THE-720) — the half derived.liveness structurally cannot see.
//
// derived.liveness classifies TABLES by row count. chunk_retrievals had 97 rows for 18 days and
// reported `live` the whole time, while the judgement columns were NULL on all 97 — the signal
// three tickets depend on, invisible to a row count. note_quality is the same shape from the other
// direction: 1,151 rows, quality_score NULL on 1,111, and 36 of the 40 scored rows carrying the
// identical 0.30. Row count passes; the distribution does not.
//
// The cry-wolf discipline from derived.liveness carries over unchanged, and gains one case of its
// own: when the TABLE is empty the column says nothing, and reporting it would double-count a
// finding derived.liveness already owns.
import { describe, expect, it } from "vitest";
import { type DerivedColumnState, derivedColumnsCheck } from "../src/doctor/checks";

const ctx = { serverVersion: "test" };
const run = (states?: DerivedColumnState[]) =>
  derivedColumnsCheck(states ? { probe: () => states } : {}).run(ctx);

const col = (over: Partial<DerivedColumnState>): DerivedColumnState => ({
  column: "t.c",
  rows: 100,
  nonNull: 0,
  distinct: 0,
  writer: "enabled",
  lever: "some lever",
  ...over,
});

describe("derived.column-liveness", () => {
  it("is ok and says so when not probed — never invents a verdict", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.details?.liveness).toBe("not probed");
  });

  it("is ok when there is no store to inspect", async () => {
    const r = await run([]);
    expect(r.status).toBe("ok");
    expect(r.details?.liveness).toBe("no store");
  });

  // THE-718's exact finding, and the reason this check exists.
  it("a populated table whose column is 100% NULL warns when the writer is ENABLED", async () => {
    const r = await run([
      col({
        column: "experiential.chunk_retrievals.feedback",
        rows: 97,
        nonNull: 0,
        writer: "enabled",
        lever: "an agent calling record_retrieval_feedback",
      }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.details?.silent).toEqual([
      "experiential.chunk_retrievals.feedback (an agent calling record_retrieval_feedback)",
    ]);
    expect(r.issues?.join(" ")).toContain("97 rows");
    expect(r.remediation).toBeTruthy();
  });

  // The cry-wolf guard, inherited from derived.liveness.
  it("a 100% NULL column whose writer is DISABLED is ok", async () => {
    const r = await run([
      col({ column: "chunk_retrievals.citation_score", rows: 97, nonNull: 0, writer: "disabled" }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.off).toEqual(["chunk_retrievals.citation_score"]);
    expect(r.issues).toBeUndefined();
  });

  it("a 100% NULL on-demand column is reported but does NOT warn", async () => {
    const r = await run([
      col({ column: "chunk_retrievals.feedback", rows: 97, nonNull: 0, writer: "on-demand" }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.neverStamped).toEqual(["chunk_retrievals.feedback"]);
    expect(r.issues).toBeUndefined();
  });

  it("a column with NO writer warns, separately from a disabled one", async () => {
    const r = await run([
      col({ column: "a.x", rows: 5, nonNull: 0, writer: "none", lever: "no writer exists" }),
      col({ column: "b.y", rows: 5, nonNull: 0, writer: "disabled" }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.details?.unwritten).toEqual(["a.x (no writer exists)"]);
    expect(r.details?.off).toEqual(["b.y"]);
  });

  // The double-reporting guard. derived.liveness already warns that the table is empty; saying it
  // again per column would turn one finding into five and bury the real ones.
  it("an EMPTY table makes its columns inconclusive, never a finding", async () => {
    const r = await run([
      col({ column: "gap_reports.score", rows: 0, nonNull: 0, writer: "enabled" }),
      col({ column: "gap_reports.query", rows: 0, nonNull: 0, writer: "enabled" }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.inconclusive).toEqual(["gap_reports.score", "gap_reports.query"]);
    expect(r.details?.silent).toBeUndefined();
    expect(r.issues).toBeUndefined();
  });

  it("a column with varied values is live", async () => {
    const r = await run([
      col({ column: "chunk_retrievals.feedback", rows: 97, nonNull: 40, distinct: 3 }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.live).toEqual(["chunk_retrievals.feedback=40/97"]);
  });

  // The note_quality shape: written, non-NULL, and carrying one value forever. As dead as NULL for
  // any consumer that ranks on it, but REPORTED rather than warned — a status column that is
  // legitimately all-'ok' is healthy, and warning on it is how this check would get muted.
  it("a written column with a single distinct value is reported as constant, not warned", async () => {
    const r = await run([
      col({ column: "note_quality.quality_score", rows: 1151, nonNull: 40, distinct: 1 }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.constant).toEqual(["note_quality.quality_score (40 rows, 1 distinct value)"]);
    expect(r.issues).toBeUndefined();
  });

  it("constant columns do not mask a real silent column alongside them", async () => {
    const r = await run([
      col({ column: "note_quality.quality_score", rows: 1151, nonNull: 40, distinct: 1 }),
      col({ column: "chunk_retrievals.feedback", rows: 97, nonNull: 0, writer: "enabled" }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.details?.silent).toEqual(["chunk_retrievals.feedback (some lever)"]);
    expect(r.details?.constant).toHaveLength(1);
    expect(r.issues?.join(" ")).not.toContain("quality_score");
  });

  it("never returns fail — a dead column breaks no request in flight", async () => {
    const r = await run([col({ rows: 10, nonNull: 0, writer: "enabled" })]);
    expect(r.status).toBe("warning");
    expect(r.status).not.toBe("fail");
  });

  // The floor. A scan that covers nothing reports success, so the count is in the summary where a
  // regression to zero is visible rather than silently green.
  it("states how many columns it scanned, so a scan of nothing cannot read as healthy", async () => {
    const r = await run([
      col({ column: "a.x", rows: 9, nonNull: 9, distinct: 4 }),
      col({ column: "b.y", rows: 9, nonNull: 9, distinct: 4 }),
    ]);
    expect(r.summary).toContain("2 columns");
  });
});
