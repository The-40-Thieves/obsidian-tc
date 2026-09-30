// The slope helper must be able to FAIL. A scaling check that only ever sees linear code proves
// nothing about its own cutoff, so these cases feed it a deliberately quadratic subject and assert
// it refuses it, and a linear one and assert it accepts it.
import { describe, expect, it } from "vitest";
import { expectLinear } from "./scaling";

// Sink so the optimizer cannot delete the loops; masked so it stays a small integer.
const sink = { n: 0 };

function burnLinear(s: string): void {
  let acc = 0;
  for (let i = 0; i < s.length * 2000; i++) acc += i & 7;
  sink.n = (sink.n + acc) & 0xffff;
}

function burnQuadratic(s: string): void {
  let acc = 0;
  for (let i = 0; i < s.length; i++) for (let j = 0; j < s.length; j++) acc += j & 7;
  sink.n = (sink.n + acc) & 0xffff;
}

// The quadratic case burns ~1 s at its largest size (more on a slow runner): past the 5 s default.
describe("expectLinear", { timeout: 60_000 }, () => {
  it("accepts a linear subject", () => {
    expectLinear("x", burnLinear, { baseBytes: 1024, boundMsPer80KB: null });
  });

  it("refuses a quadratic subject", () => {
    // 4096, not smaller: the helper floors times at 1 ms, so a 1x pass that is sub-millisecond on a
    // fast runner (windows measured a slope under 1.6 at 1024) flattens the fit.
    expect(() =>
      expectLinear("x", burnQuadratic, { baseBytes: 4096, boundMsPer80KB: null }),
    ).toThrow(/log-log slope/);
  });

  it("refuses a linear subject that is over the absolute bound", () => {
    expect(() => expectLinear("x", burnLinear, { baseBytes: 1024, boundMsPer80KB: 0.001 })).toThrow(
      /at \d+ bytes/,
    );
  });
});
