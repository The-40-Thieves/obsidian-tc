// THE-521: the doctor framework. Two design rules come straight from the prior-art research and each
// is a test here:
//   - JSON is the PRIMARY value; text is rendered FROM it. Flutter emitted text and could never
//     retrofit JSON (flutter#10621, closed not-planned after 8 years). So runDoctor returns the
//     structured report and renderText takes that report — text can never carry a fact the JSON lacks.
//   - Every check is an independently testable object. The framework times it, assigns the stable id,
//     and — critically — a check that THROWS becomes a fail result, never a crash of the whole run.
//
// Schema mirrors the merged `codex doctor --json` (codex-rs/cli/src/doctor.rs): camelCase keys,
// status enum ok|warning|fail, and `checks` is an OBJECT keyed by dotted id (not an array) so support
// tooling can read checks["auth.maxAge"] without scanning.
import { describe, expect, it } from "vitest";
import { renderText, runDoctor } from "../src/doctor";
import type { Check } from "../src/doctor/types";

const ok = (id: string, category = "test"): Check => ({
  id,
  category,
  run: () => ({ status: "ok", summary: `${id} fine` }),
});

describe("THE-521 doctor framework", () => {
  it("returns a versioned envelope with checks keyed by id", async () => {
    const report = await runDoctor([ok("runtime.versions"), ok("auth.policy")], {
      serverVersion: "1.10.0",
      now: () => "2026-07-22T00:00:00.000Z",
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(report.serverVersion).toBe("1.10.0");
    // object keyed by id, not an array
    expect(Object.keys(report.checks).sort()).toEqual(["auth.policy", "runtime.versions"]);
    expect(report.checks["auth.policy"]?.status).toBe("ok");
  });

  it("aggregates overallStatus as fail > warning > ok", async () => {
    const warn: Check = {
      id: "a",
      category: "t",
      run: () => ({ status: "warning", summary: "w" }),
    };
    const fail: Check = { id: "b", category: "t", run: () => ({ status: "fail", summary: "f" }) };

    expect((await runDoctor([ok("x")], baseCtx)).overallStatus).toBe("ok");
    expect((await runDoctor([ok("x"), warn], baseCtx)).overallStatus).toBe("warning");
    expect((await runDoctor([ok("x"), warn, fail], baseCtx)).overallStatus).toBe("fail");
  });

  it("turns a throwing check into a fail result instead of crashing the run", async () => {
    const boom: Check = {
      id: "provider.embeddings",
      category: "provider",
      run: () => {
        throw new Error("connection refused");
      },
    };
    const report = await runDoctor([ok("runtime.versions"), boom], baseCtx);
    expect(report.checks["runtime.versions"]?.status).toBe("ok"); // the good one still ran
    const bad = report.checks["provider.embeddings"];
    expect(bad?.status).toBe("fail");
    expect(bad?.issues?.[0]).toMatch(/connection refused/);
    expect(report.overallStatus).toBe("fail");
  });

  it("stamps each check with a duration", async () => {
    let t = 100;
    const report = await runDoctor([ok("x")], { ...baseCtx, monotonic: () => (t += 5) });
    expect(report.checks.x?.durationMs).toBe(5);
  });

  it("carries an empty envelope (no checks) as ok rather than throwing", async () => {
    const report = await runDoctor([], baseCtx);
    expect(report.overallStatus).toBe("ok");
    expect(report.checks).toEqual({});
  });

  it("renders human text FROM the report, one line per check with its status", async () => {
    const report = await runDoctor(
      [
        ok("runtime.versions"),
        {
          id: "auth.policy",
          category: "auth",
          run: () => ({ status: "warning", summary: "mode is none" }),
        },
      ],
      baseCtx,
    );
    const text = renderText(report);
    expect(text).toContain("runtime.versions");
    expect(text).toContain("auth.policy");
    expect(text).toContain("mode is none");
    // the overall status is surfaced in the text too
    expect(text.toLowerCase()).toContain("warning");
  });
});

const baseCtx = { serverVersion: "1.10.0", now: () => "2026-07-22T00:00:00.000Z" };
