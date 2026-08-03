// entrypoints.liveness — derived.liveness, applied to VERBS instead of TABLES.
//
// derived.liveness answers "is this table being written". It cannot answer "is this pass registered
// at all" or "has anything ever called this tool", and those are the two shapes that produced
// THE-714 (workspace_sessions: no client ever called start_session), THE-717 (inferCitations is
// CLI-only) and THE-719 (the gaps pass is CLI-only). A 2026-08-03 census measured 27 distinct tools
// invoked in 18 days against 154 registered, and nothing reported it.
//
// The cry-wolf discipline carries over verbatim and is the reason for most of these tests. An
// unexercised tool is NOT a fault — warning on "nobody called list_vaults this month" is exactly the
// noise that got experiential.evaluator muted. Only two things warn: a pass that has run and never
// once succeeded, and a pass that is failing now.
import { describe, expect, it } from "vitest";
import {
  type EntryPointsProbe,
  entryPointsCheck,
  type ScheduledPassState,
  type ToolCensus,
} from "../src/doctor/entrypoints";

const ctx = { serverVersion: "test" };
const run = (probe?: EntryPointsProbe) =>
  entryPointsCheck(probe ? { probe: () => probe } : {}).run(ctx);

const pass = (over: Partial<ScheduledPassState>): ScheduledPassState => ({
  name: "p",
  lastRunAt: 1_000,
  lastSuccessAt: 1_000,
  consecutiveFailures: 0,
  ...over,
});

const census = (over: Partial<ToolCensus> = {}): ToolCensus => ({
  distinctTools: 27,
  episodes: 357,
  firstAt: 1_000,
  lastAt: 2_000,
  ...over,
});

const probe = (over: Partial<EntryPointsProbe> = {}): EntryPointsProbe => ({
  passes: [],
  tools: null,
  orphanScheduleRows: 0,
  ...over,
});

describe("entrypoints.liveness", () => {
  it("is ok and says so when not probed — never invents a verdict", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.details?.entrypoints).toBe("not probed");
  });

  it("is ok when there is nothing to inspect", async () => {
    const r = await run(probe());
    expect(r.status).toBe("ok");
    expect(r.details?.entrypoints).toBe("no scheduler state");
  });

  it("reports a healthy schedule without warning", async () => {
    const r = await run(
      probe({
        passes: [
          pass({ name: "maintenance-sweep" }),
          pass({ name: "job-queue-runner" }),
          pass({ name: "plane-enqueue" }),
        ],
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.details?.scheduled).toEqual([
      "maintenance-sweep",
      "job-queue-runner",
      "plane-enqueue",
    ]);
    expect(r.issues).toBeUndefined();
  });

  it("WARNS on a pass that has run and never once succeeded — THE-717's shape", async () => {
    // This is the whole reason the check exists. A registered pass that ticks and fails every time
    // leaves its output table empty, so derived.liveness reports the table as `silent` and names a
    // lever that is already switched on. Only the schedule row distinguishes "nothing enabled it"
    // from "it is enabled and losing".
    const r = await run(
      probe({
        passes: [
          pass({ name: "maintenance-sweep" }),
          pass({ name: "citation-infer", lastRunAt: 5_000, lastSuccessAt: null }),
        ],
      }),
    );
    expect(r.status).toBe("warning");
    expect(r.details?.neverSucceeded).toEqual(["citation-infer"]);
    expect(r.issues?.join(" ")).toContain("citation-infer");
    expect(r.issues?.join(" ")).toContain("never succeeded");
    expect(r.remediation).toBeTruthy();
  });

  it("WARNS on a pass that succeeded before but is failing now", async () => {
    const r = await run(
      probe({
        passes: [pass({ name: "synthesis", lastSuccessAt: 1_000, consecutiveFailures: 3 })],
      }),
    );
    expect(r.status).toBe("warning");
    expect(r.details?.failing).toEqual(["synthesis (3 consecutive)"]);
    expect(r.issues?.join(" ")).toContain("synthesis");
  });

  it("a registered pass that has NEVER TICKED is reported, not warned", async () => {
    // A pass whose interval has not elapsed since boot has null last_run_at. Warning on it would
    // fire on every fresh install for as long as the longest interval, which is how a check earns
    // being ignored.
    const r = await run(
      probe({
        passes: [
          pass({ name: "vault-reconcile", lastRunAt: null, lastSuccessAt: null }),
          pass({ name: "maintenance-sweep" }),
        ],
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.details?.notYetRun).toEqual(["vault-reconcile"]);
    expect(r.issues).toBeUndefined();
  });

  it("never-ticked does not mask a genuinely failing pass alongside it", async () => {
    const r = await run(
      probe({
        passes: [
          pass({ name: "vault-reconcile", lastRunAt: null, lastSuccessAt: null }),
          pass({ name: "citation-infer", lastRunAt: 5_000, lastSuccessAt: null }),
        ],
      }),
    );
    expect(r.status).toBe("warning");
    expect(r.details?.neverSucceeded).toEqual(["citation-infer"]);
    expect(r.details?.notYetRun).toEqual(["vault-reconcile"]);
    expect(r.issues?.join(" ")).not.toContain("vault-reconcile");
  });

  it("reports the tool census as a LOWER BOUND and never warns on it", async () => {
    // 27 of 154 invoked is the real 2026-08-03 measurement. It must never be a warning: episode
    // capture is per-caller and the eval harness and CLI bypass it entirely, so a low number is
    // as likely to mean "capture is narrow" as "the surface is dead".
    const r = await run(
      probe({
        passes: [pass({ name: "maintenance-sweep" })],
        tools: census({ distinctTools: 27, episodes: 357 }),
      }),
    );
    expect(r.status).toBe("ok");
    expect(String(r.details?.toolsInvoked)).toContain("27");
    expect(String(r.details?.toolsInvoked)).toContain("357");
    expect(String(r.details?.toolsInvoked)).toContain("at least");
    expect(r.issues).toBeUndefined();
  });

  it("says the tool census is unmeasured rather than reporting zero", async () => {
    // The failure this pins: episode capture off would make every tool look never-called. Encoding
    // "not measured" as the number 0 is the feedback-failure-encoded-as-a-valid-result shape —
    // downstream it is indistinguishable from a measured zero.
    const r = await run(probe({ passes: [pass({ name: "maintenance-sweep" })], tools: null }));
    expect(r.status).toBe("ok");
    expect(r.details?.toolsInvoked).toBe("not measured (no episode capture in this store)");
  });

  it("an empty census is reported as measured-zero, distinctly from unmeasured", async () => {
    const r = await run(
      probe({
        passes: [pass({ name: "maintenance-sweep" })],
        tools: census({ distinctTools: 0, episodes: 0, firstAt: null, lastAt: null }),
      }),
    );
    expect(r.details?.toolsInvoked).not.toBe("not measured (no episode capture in this store)");
    expect(String(r.details?.toolsInvoked)).toContain("0");
    expect(r.status).toBe("ok");
  });

  it("surfaces orphaned schedule rows without warning — THE-715 is already ticketed", async () => {
    const r = await run(
      probe({ passes: [pass({ name: "maintenance-sweep" })], orphanScheduleRows: 2979 }),
    );
    expect(r.status).toBe("ok");
    expect(String(r.details?.scheduleOrphans)).toContain("2979");
    expect(r.issues).toBeUndefined();
  });

  it("omits the orphan detail entirely when there are none", async () => {
    const r = await run(probe({ passes: [pass({ name: "maintenance-sweep" })] }));
    expect(r.details?.scheduleOrphans).toBeUndefined();
  });

  it("never returns fail — a dead entry point breaks no request in flight", async () => {
    const r = await run(
      probe({
        passes: [
          pass({ name: "a", lastRunAt: 5, lastSuccessAt: null }),
          pass({ name: "b", consecutiveFailures: 9 }),
        ],
      }),
    );
    expect(r.status).toBe("warning");
    expect(r.status).not.toBe("fail");
  });

  it("counts both failure kinds in the summary so neither hides the other", async () => {
    const r = await run(
      probe({
        passes: [
          pass({ name: "n1", lastRunAt: 5, lastSuccessAt: null }),
          pass({ name: "n2", lastRunAt: 5, lastSuccessAt: null }),
          pass({ name: "f1", consecutiveFailures: 2 }),
          pass({ name: "ok1" }),
        ],
      }),
    );
    expect(r.summary).toContain("2 never succeeded");
    expect(r.summary).toContain("1 failing");
    expect(r.summary).toContain("1 healthy");
  });
});
