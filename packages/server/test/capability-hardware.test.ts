// THE-522: hardware envelope. Descriptive, not prescriptive — obsidian-tc is CPU-only by design, so
// this exists so agents and tests stop GUESSING the machine, never to drive a GPU code path.
//
// The baseline (platform/arch/cpu count/total mem) comes from node:os and is always available. The
// enrichment (cpu brand, gpu presence) comes from systeminformation, which shells out and can fail
// on a locked-down box — so the enricher is injected here to prove that a throwing provider degrades
// to the os-only baseline rather than taking down the whole profile.
import { describe, expect, it } from "vitest";
import { hardwareEnvelope } from "../src/capability/hardware";

describe("THE-522 hardware envelope", () => {
  // The ONLY case here that runs the real systeminformation enricher, so it is the only one whose
  // runtime depends on the OS. `si.graphics()` shells out to WMI on Windows and has repeatedly blown
  // vitest's 5000ms default on windows-latest. The explicit timeout must stay comfortably ABOVE
  // hardware.ts's own ENRICH_TIMEOUT_MS (2s) — bound the outer wait looser than the inner one, or the
  // inner bound can never fire and this asserts nothing about the degrade path.
  it("reports the os-level baseline from real node:os data", { timeout: 15_000 }, async () => {
    const hw = await hardwareEnvelope();
    expect(hw.platform).toBe(process.platform);
    expect(hw.arch).toBe(process.arch);
    expect(hw.cpuCount).toBeGreaterThan(0);
    expect(hw.totalMemMb).toBeGreaterThan(0);
  });

  it("folds in cpu brand and gpu presence from the enricher", async () => {
    const hw = await hardwareEnvelope(async () => ({
      cpuBrand: "Ampere Neoverse-N1",
      gpus: [{ vendor: "NVIDIA", model: "A100", vramMb: 40960 }],
    }));
    expect(hw.cpuBrand).toBe("Ampere Neoverse-N1");
    expect(hw.hasGpu).toBe(true);
    expect(hw.gpus[0]?.model).toBe("A100");
  });

  it("reports hasGpu=false when the enricher finds no controllers", async () => {
    const hw = await hardwareEnvelope(async () => ({ cpuBrand: "x", gpus: [] }));
    expect(hw.hasGpu).toBe(false);
    expect(hw.gpus).toEqual([]);
  });

  it("degrades to the baseline when the enricher throws, without rejecting", async () => {
    const hw = await hardwareEnvelope(async () => {
      throw new Error("systeminformation unavailable in this sandbox");
    });
    expect(hw.cpuCount).toBeGreaterThan(0); // baseline still present
    expect(hw.cpuBrand).toBeUndefined();
    expect(hw.hasGpu).toBe(false);
    expect(hw.gpus).toEqual([]);
  });

  // Regression: an enricher that STALLS is not the same failure as one that throws. Only a rejection
  // reaches the catch above, so before the timeout landed this call never returned and the caller —
  // capabilityProfile(), a live tool path — hung with it. The test timeout is deliberately 200x the
  // enrichment bound: if the bound is ever removed this fails on the vitest deadline rather than
  // silently passing.
  it("degrades to the baseline when the enricher never settles", { timeout: 10_000 }, async () => {
    const started = Date.now();
    const hw = await hardwareEnvelope(() => new Promise<never>(() => {}), 50);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hw.cpuCount).toBeGreaterThan(0); // baseline still present
    expect(hw.cpuBrand).toBeUndefined();
    expect(hw.hasGpu).toBe(false);
    expect(hw.gpus).toEqual([]);
  });

  // The timer must not outlive the call. If `finally { clearTimeout }` is dropped, this test still
  // passes its assertions but leaves a 30s handle on the event loop — so assert the fast path returns
  // promptly AND keep the bound huge, which is what makes a leaked timer visible as a hung teardown.
  it("does not wait for the timeout when the enricher resolves fast", async () => {
    const started = Date.now();
    const hw = await hardwareEnvelope(async () => ({ cpuBrand: "fast", gpus: [] }), 30_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hw.cpuBrand).toBe("fast");
  });
});
