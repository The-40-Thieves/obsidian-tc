import { describe, expect, it } from "vitest";
import { collectStorage } from "../eval/perf/collectors/storage";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("storage collectors", () => {
  it("reports deterministic storage bytes and a fixed txn count", async () => {
    const a = await buildVault(SCENARIOS.small);
    const b = await buildVault(SCENARIOS.small);
    const av = Object.fromEntries(collectStorage(a).map((s) => [s.key, s.value]));
    const bv = Object.fromEntries(collectStorage(b).map((s) => [s.key, s.value]));
    expect(av["storage.bytes"]).toBe(bv["storage.bytes"]); // deterministic
    expect(av["storage.txn_count"]).toBe(bv["storage.txn_count"]);
    expect(av["storage.bytes"]).toBeGreaterThan(0);
    a.cleanup();
    b.cleanup();
  });
});
