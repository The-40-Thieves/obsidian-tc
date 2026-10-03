// Keep the real hardware probe out of the vitest suite. hardware.ts's enricher runs
// `systeminformation`, which on Windows starts powershell.exe (WMI, and `Add-Type` for graphics);
// hardware.ts abandons it after 2 s and the child keeps running, with the test's HOME/APPDATA in its
// environment, for as long as it likes. Every test that reaches `resolveCapabilityProfile` (setup,
// doctor, the first-run fallback) therefore left a live process holding a handle under the test's
// temp home when the test removed it: the "N temp entries outlived the test file" failures on
// windows-latest (setup-first-run-fallback-e2e, first-run-fallback-wx-race, setup-e2e).
//
// A file that wants the real enricher opts out with `vi.unmock("systeminformation")` (the one case
// in capability-hardware.test.ts does, and awaits it).
import { vi } from "vitest";

vi.mock("systeminformation", () => {
  const si = {
    cpu: async () => ({ manufacturer: "Test", brand: "CPU" }),
    graphics: async () => ({ controllers: [] }),
  };
  return { ...si, default: si };
});
