// The scaling helpers must be able to FAIL. A scaling check that only ever sees linear code proves
// nothing about its own cutoff, so these cases feed them a deliberately quadratic subject and assert
// they refuse it, and a linear one and assert they accept it.
//
// The refusals are DETERMINISTIC: `assertScalingFit` is fed fixed (size, time) points, and
// `expectLinearWork` counts steps. Timing a quadratic burn here instead (as this file used to) made
// the negative control luck-dependent: a fast or coarse-clocked runner (windows CPU time ticks every
// ~15 ms) can measure the quadratic pass under the timer's resolution, fit a flat slope, and the
// control passes when it must throw.
import { describe, expect, it } from "vitest";
import { assertScalingFit, countWork, expectLinear, expectLinearWork } from "./scaling";

// Sink so the optimizer cannot delete the loops; masked so it stays a small integer.
const sink = { n: 0 };

function burnLinear(s: string): void {
  let acc = 0;
  for (let i = 0; i < s.length * 2000; i++) acc += i & 7;
  sink.n = (sink.n + acc) & 0xffff;
}

// Points shaped like four doublings: 10 ms at 1x, then x2 (linear) or x4 (quadratic) each step.
const linearPoints = [1, 2, 4, 8].map((k) => ({ bytes: k * 1024, ms: 10 * k }));
const quadraticPoints = [1, 2, 4, 8].map((k) => ({ bytes: k * 1024, ms: 10 * k * k }));

describe("assertScalingFit (the verdict half of expectLinear, no clock)", () => {
  it("accepts linear points", () => {
    expect(() => assertScalingFit("x", linearPoints, null)).not.toThrow();
  });

  it("refuses quadratic points", () => {
    expect(() => assertScalingFit("x", quadraticPoints, null)).toThrow(/log-log slope/);
  });

  it("refuses linear points that are over the absolute bound", () => {
    // 10 ms at 1 KB is 800 ms per 80 KB: over a 100 ms bound, though the slope is fine.
    expect(() => assertScalingFit("x", linearPoints, 100)).toThrow(/at \d+ bytes/);
    expect(() => assertScalingFit("x", linearPoints, 1000)).not.toThrow();
  });
});

describe("expectLinearWork (counts steps, no clock)", () => {
  it("counts exactly what the subject ticks", () => {
    expect(countWork((s, tick) => tick(s.length * 3), "abcd")).toBe(12);
  });

  it("counts String.prototype searches and reads when asked, and restores them after", () => {
    const { indexOf, slice, startsWith, charCodeAt } = String.prototype;
    const work = countWork(
      (s) => {
        s.indexOf("c", 0); // walks to offset 2, +1 for the call
        s.slice(1, 3); // copies 2, +1
        s.startsWith("ab"); // reads 2, +1
        s.charCodeAt(0); // +1
      },
      "abcd",
      true,
    );
    expect(work).toBe(3 + 3 + 3 + 1);
    expect(String.prototype.indexOf).toBe(indexOf);
    expect(String.prototype.slice).toBe(slice);
    expect(String.prototype.startsWith).toBe(startsWith);
    expect(String.prototype.charCodeAt).toBe(charCodeAt);
  });

  it("restores String.prototype even when the subject throws", () => {
    const { indexOf } = String.prototype;
    expect(() =>
      countWork(
        () => {
          throw new Error("boom");
        },
        "x",
        true,
      ),
    ).toThrow("boom");
    expect(String.prototype.indexOf).toBe(indexOf);
  });

  it("accepts a linear subject", () => {
    expectLinearWork("x", (s, tick) => tick(s.length * 5), { baseBytes: 1024 });
  });

  it("refuses a quadratic subject", () => {
    expect(() =>
      expectLinearWork("x", (s, tick) => tick(s.length * s.length), { baseBytes: 1024 }),
    ).toThrow(/log-log slope/);
  });

  it("refuses work per byte under the floor (a counter that sees nothing is not a pass)", () => {
    expect(() => expectLinearWork("x", () => {}, { baseBytes: 1024, minWorkPerByte: 0.5 })).toThrow(
      /work per byte/,
    );
  });

  it("refuses work per byte over the ceiling (a large linear constant)", () => {
    expect(() =>
      expectLinearWork("x", (s, tick) => tick(s.length * 600), {
        baseBytes: 1024,
        maxWorkPerByte: 8,
      }),
    ).toThrow(/work per byte/);
  });
});

// One real-clock wiring check: expectLinear times the subject and hands the points to
// assertScalingFit. Only the ACCEPT direction is asserted on a clock; a refusal measured on a clock
// is what flaked.
describe("expectLinear", { timeout: 60_000 }, () => {
  it("accepts a linear subject", () => {
    expectLinear("x", burnLinear, { baseBytes: 1024, boundMsPer80KB: null });
  });
});
