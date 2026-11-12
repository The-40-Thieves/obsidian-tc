import { err, ReliquaryTcError } from "@the-40-thieves/reliquary-tc-shared";
import { describe, expect, it } from "vitest";
import { withDegradeHint } from "../src/tools/m4/shared";

describe("withDegradeHint", () => {
  it.each([
    err.pluginMissing("no tasks plugin", { plugin: "tasks" }),
    err.pluginUnreachable("endpoint down", { plugin: "tasks" }),
    err.requiresLiveObsidian("headless vault", { plugin: "tasks" }),
  ])("enriches a $code degrade, preserving code + details", (e) => {
    const out = withDegradeHint(e, "use list_tasks");
    expect(out).toBeInstanceOf(ReliquaryTcError);
    const o = out as ReliquaryTcError;
    expect(o.code).toBe(e.code);
    expect(o.details?.hint).toBe("use list_tasks");
    expect(o.details?.plugin).toBe("tasks");
  });

  it("passes non-degrade errors through unchanged (same reference)", () => {
    const e = err.invalidInput("bad");
    expect(withDegradeHint(e, "hint")).toBe(e);
    const random = new Error("x");
    expect(withDegradeHint(random, "hint")).toBe(random);
  });
});
