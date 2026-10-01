import { afterEach, describe, expect, it } from "vitest";
import { perfTimeout } from "./perf-timeouts";
import { runBunSync } from "./spawn-cli";
import { stallTimeout, WINDOWS_STALL_TIMEOUT_MS } from "./stall-timeouts";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p });
}
afterEach(() => setPlatform(realPlatform));

describe("stallTimeout", () => {
  it("keeps the tight budget on linux and darwin", () => {
    for (const p of ["linux", "darwin"] as const) {
      setPlatform(p);
      expect(stallTimeout(5_000)).toBe(5_000);
      expect(stallTimeout(120_000)).toBe(120_000);
    }
  });

  it("raises a tight budget to the stall ceiling on win32 and never lowers a larger one", () => {
    setPlatform("win32");
    expect(stallTimeout(5_000)).toBe(WINDOWS_STALL_TIMEOUT_MS);
    expect(stallTimeout(20_000)).toBe(WINDOWS_STALL_TIMEOUT_MS);
    expect(stallTimeout(120_000)).toBe(120_000);
  });

  it("is the same function the perf-harness tests use (one constant, no second ceiling)", () => {
    setPlatform("win32");
    expect(perfTimeout(15_000)).toBe(stallTimeout(15_000));
    expect(perfTimeout(15_000)).toBe(WINDOWS_STALL_TIMEOUT_MS);
  });
});

describe("runBunSync", () => {
  it.skipIf(process.platform === "win32")(
    "reports a killed child as -1 and a normal exit as its status",
    () => {
      const ok = runBunSync(["-e", "process.stdout.write('hi'); process.exit(3)"]);
      expect(ok).toMatchObject({ code: 3, stdout: "hi" });
      const killed = runBunSync(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
      expect(killed.code).toBe(-1);
    },
  );
});
