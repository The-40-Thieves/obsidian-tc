import { describe, expect, it } from "vitest";
import { resolveVitestTimeoutFloorMs } from "./vitest-timeout-floor";

describe("vitest timeout floor resolution", () => {
  it("applies no floor when the knob is unset or empty", () => {
    expect(resolveVitestTimeoutFloorMs({})).toBeUndefined();
    expect(resolveVitestTimeoutFloorMs({ VITEST_TIMEOUT_FLOOR_MS: "" })).toBeUndefined();
  });

  it("uses a positive integer as the floor", () => {
    expect(resolveVitestTimeoutFloorMs({ VITEST_TIMEOUT_FLOOR_MS: "15000" })).toBe(15_000);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects %j", (raw) => {
    expect(() => resolveVitestTimeoutFloorMs({ VITEST_TIMEOUT_FLOOR_MS: raw })).toThrow(
      `VITEST_TIMEOUT_FLOOR_MS must be a positive integer, got "${raw}"`,
    );
  });
});
