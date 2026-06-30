import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { withDegradeHint } from "../src/tools/m4/shared";

describe("withDegradeHint", () => {
  it("adds a hint to plugin_missing / plugin_unreachable degrades, preserving code + details", () => {
    for (const e of [
      err.pluginMissing("no tasks plugin", { plugin: "tasks" }),
      err.pluginUnreachable("endpoint down", { plugin: "tasks" }),
    ]) {
      const out = withDegradeHint(e, "use list_tasks");
      expect(out).toBeInstanceOf(ObsidianTcError);
      const o = out as ObsidianTcError;
      expect(o.code).toBe(e.code);
      expect(o.details?.hint).toBe("use list_tasks");
      expect(o.details?.plugin).toBe("tasks");
    }
  });
  it("passes non-degrade errors through unchanged (same reference)", () => {
    const e = err.invalidInput("bad");
    expect(withDegradeHint(e, "hint")).toBe(e);
    const random = new Error("x");
    expect(withDegradeHint(random, "hint")).toBe(random);
  });
});
