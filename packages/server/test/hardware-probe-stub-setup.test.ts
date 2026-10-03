// Pins test/hardware-probe-stub-setup.ts: the suite never runs the real `systeminformation` probe
// (on Windows a powershell.exe that hardware.ts abandons after 2 s and that then holds handles under
// the test's temp home), so the default enricher answers from the stub.
import { describe, expect, it } from "vitest";
import { hardwareEnvelope } from "../src/capability/hardware";

describe("hardware probe stub (setupFiles)", () => {
  it("the default enricher is the stub: a fixed cpu brand and no gpu, instantly", async () => {
    const hw = await hardwareEnvelope();
    expect(hw.cpuBrand).toBe("Test CPU");
    expect(hw.hasGpu).toBe(false);
    expect(hw.gpus).toEqual([]);
  });
});
