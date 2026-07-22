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
  it("reports the os-level baseline from real node:os data", async () => {
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
});
