// derived.liveness — the generalisation of THE-688 / THE-692 / THE-714.
//
// The classification is the point, not the counting. A check that warned on "rows === 0" would fire
// on every deliberately-disabled feature and be muted within a week — the same way
// experiential.evaluator cried wolf when it keyed on pending count instead of promotable age. So
// these tests pin the four states separately, and specifically pin that a DISABLED writer with an
// empty table stays OK.
import { describe, expect, it } from "vitest";
import { type DerivedTableState, derivedTablesCheck } from "../src/doctor/checks";

const ctx = { serverVersion: "test" };
const run = (states?: DerivedTableState[]) =>
  derivedTablesCheck(states ? { probe: () => states } : {}).run(ctx);

const state = (over: Partial<DerivedTableState>): DerivedTableState => ({
  table: "t",
  rows: 0,
  writer: "enabled",
  lever: "some lever",
  ...over,
});

describe("derived.liveness", () => {
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

  it("an EMPTY table whose writer is DISABLED is ok — this is the cry-wolf guard", async () => {
    // The whole reason this check classifies instead of counting. chunk_sparse is empty on a
    // dense-only deployment and that is correct, not a finding.
    const r = await run([
      state({ table: "chunk_sparse", rows: 0, writer: "disabled" }),
      state({ table: "chunk_colbert", rows: 0, writer: "disabled" }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.off).toEqual(["chunk_sparse", "chunk_colbert"]);
    expect(r.issues).toBeUndefined();
  });

  it("an EMPTY table whose writer is ENABLED warns — configured but never wrote", async () => {
    const r = await run([
      state({ table: "chunk_sparse", rows: 4210, writer: "enabled" }),
      state({ table: "workspace_sessions", rows: 0, writer: "enabled", lever: "start_session" }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.details?.silent).toEqual(["workspace_sessions (start_session)"]);
    expect(r.issues?.join(" ")).toContain("workspace_sessions");
    expect(r.remediation).toBeTruthy();
    // The healthy table is still reported, so the operator sees the whole picture.
    expect(r.details?.live).toEqual(["chunk_sparse=4210"]);
  });

  it("a table with NO writer warns, and is reported separately from a disabled one", async () => {
    // THE-629's shape: memory_entities has existed since the initial migration with nothing
    // populating it. Reporting that as "off by config" would hide it — there is no config.
    const r = await run([
      state({ table: "memory_entities", rows: 0, writer: "none", lever: "no writer exists" }),
      state({ table: "chunk_sparse", rows: 0, writer: "disabled" }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.details?.unwritten).toEqual(["memory_entities (no writer exists)"]);
    expect(r.details?.off).toEqual(["chunk_sparse"]);
    expect(r.issues?.join(" ")).toContain("no code path writes this table");
  });

  it("an EMPTY on-demand table is reported but does NOT warn", async () => {
    // The regression this pins: classifying capture_queue / note_snapshots / forget_log as
    // "enabled" produced eleven warnings on a healthy deployment. "Nobody has ever deleted a note"
    // is true and useless, and a check that warns about correct behaviour gets muted.
    const r = await run([
      state({ table: "note_snapshots", rows: 0, writer: "on-demand" }),
      state({ table: "capture_queue", rows: 0, writer: "on-demand" }),
      state({ table: "chunks", rows: 900, writer: "enabled" }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.details?.neverUsed).toEqual(["note_snapshots", "capture_queue"]);
    expect(r.issues).toBeUndefined();
    expect(r.summary).toContain("2 awaiting first use");
  });

  it("an on-demand table WITH rows is simply live", async () => {
    const r = await run([state({ table: "capture_queue", rows: 3, writer: "on-demand" })]);
    expect(r.status).toBe("ok");
    expect(r.details?.live).toEqual(["capture_queue=3"]);
    expect(r.details?.neverUsed).toBeUndefined();
  });

  it("on-demand emptiness does not mask a real silent table alongside it", async () => {
    const r = await run([
      state({ table: "note_snapshots", rows: 0, writer: "on-demand" }),
      state({ table: "job_runs", rows: 0, writer: "enabled", lever: "wrapPlaneJob" }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.details?.silent).toEqual(["job_runs (wrapPlaneJob)"]);
    expect(r.details?.neverUsed).toEqual(["note_snapshots"]);
    // The warning is about job_runs only — the on-demand table is not in issues.
    expect(r.issues?.join(" ")).not.toContain("note_snapshots");
  });

  it("is ok when everything with an enabled writer has rows", async () => {
    const r = await run([
      state({ table: "a", rows: 10, writer: "enabled" }),
      state({ table: "b", rows: 1, writer: "enabled" }),
      state({ table: "c", rows: 0, writer: "disabled" }),
    ]);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("2 written");
    expect(r.summary).toContain("1 off");
  });

  it("never returns fail — an empty derived table breaks no request in flight", async () => {
    const r = await run([
      state({ table: "x", rows: 0, writer: "enabled" }),
      state({ table: "y", rows: 0, writer: "none" }),
    ]);
    expect(r.status).toBe("warning");
    expect(r.status).not.toBe("fail");
  });

  it("counts both silent and unwritten in the summary so neither hides the other", async () => {
    const r = await run([
      state({ table: "s1", rows: 0, writer: "enabled" }),
      state({ table: "s2", rows: 0, writer: "enabled" }),
      state({ table: "u1", rows: 0, writer: "none" }),
      state({ table: "l1", rows: 7, writer: "enabled" }),
    ]);
    expect(r.summary).toContain("2 configured-but-empty");
    expect(r.summary).toContain("1 with no writer");
    expect(r.summary).toContain("1 written");
  });
});
