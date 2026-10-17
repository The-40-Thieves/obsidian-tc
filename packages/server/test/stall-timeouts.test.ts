import { afterEach, describe, expect, it } from "vitest";
import { perfTimeout } from "./perf-timeouts";
import { runBunSync } from "./spawn-cli";
import { stallTimeout, WINDOWS_STALL_TIMEOUT_MS } from "./stall-timeouts";

const realPlatform = process.platform;
const realFloor = process.env.VITEST_TIMEOUT_FLOOR_MS;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p });
}
function setFloor(value: string | undefined): void {
  if (value === undefined) delete process.env.VITEST_TIMEOUT_FLOOR_MS;
  else process.env.VITEST_TIMEOUT_FLOOR_MS = value;
}
afterEach(() => {
  setPlatform(realPlatform);
  setFloor(realFloor);
});

describe("stallTimeout", () => {
  it("keeps the tight budget on linux and darwin", () => {
    setFloor(undefined);
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

describe("stallTimeout with the Intel timeout floor", () => {
  it("raises a tight budget to the floor on linux and darwin and never lowers a larger one", () => {
    setFloor("15000");
    for (const p of ["linux", "darwin"] as const) {
      setPlatform(p);
      expect(stallTimeout(5_000)).toBe(15_000);
      expect(stallTimeout(120_000)).toBe(120_000);
    }
  });

  it("leaves the Windows ceiling unchanged by the floor", () => {
    setFloor("15000");
    setPlatform("win32");
    expect(stallTimeout(5_000)).toBe(WINDOWS_STALL_TIMEOUT_MS);
  });
});

describe("runBunSync", () => {
  it.skipIf(process.platform === "win32")(
    "reports a killed child as -1 and a normal exit as its status",
    () => {
      // The Intel legs' floor would stretch the 300ms kill to the test's own timeout.
      setFloor(undefined);
      const ok = runBunSync(["-e", "process.stdout.write('hi'); process.exit(3)"]);
      expect(ok).toMatchObject({ code: 3, stdout: "hi" });
      const killed = runBunSync(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
      expect(killed.code).toBe(-1);
    },
  );
});
