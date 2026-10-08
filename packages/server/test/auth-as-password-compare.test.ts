// constantTimeEqual must compare through crypto.timingSafeEqual (design v2 section 8, setup-token
// row). Equal results from `===` are indistinguishable by behaviour, so the call itself is observed.
import { describe, expect, it, vi } from "vitest";

const timingSafeEqual = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual };
});

describe("constantTimeEqual", () => {
  it("compares two equal-length digests with crypto.timingSafeEqual, whatever the input lengths", async () => {
    const { constantTimeEqual } = await import("../src/auth/as-password");
    timingSafeEqual.mockClear();
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("short", "a much longer string than the first")).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    for (const [x, y] of timingSafeEqual.mock.calls as [Buffer, Buffer][]) {
      expect(x.length).toBe(32);
      expect(y.length).toBe(32);
    }
  });
});
