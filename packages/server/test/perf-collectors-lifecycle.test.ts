import { describe, expect, it } from "vitest";
import { collectLifecycle } from "../eval/perf/collectors/lifecycle";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("lifecycle collectors", () => {
  it("reports a vec-migration rebuild flag and a shutdown-drained flag", async () => {
    const v = await buildVault(SCENARIOS.small);
    const byKey = Object.fromEntries((await collectLifecycle(v)).map((s) => [s.key, s]));
    expect(byKey["shutdown.drained"]).toBeDefined();
    expect(byKey["migration.ms"]).toBeDefined();
    expect(byKey["shutdown.drained"]!.value).toBe(1);
    expect(byKey["migration.ms"]!.class).toBe("warn");
    expect(byKey["shutdown.drained"]!.class).toBe("hard");
    // The collector closes vault.db as part of the shutdown-drain metric; harness cleanup
    // must guard its own db.close?.() so a second close (Task 10's orchestration double-close
    // hazard) never throws.
    expect(() => v.cleanup()).not.toThrow();
  });
});
