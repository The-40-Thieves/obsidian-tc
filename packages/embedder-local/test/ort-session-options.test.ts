// GH #995 — onnxruntime-node thread/spin-pool sizing. Pure function, no @huggingface/transformers
// and no os mocking needed: `cpuCount` is an explicit parameter (see ort-session-options.ts).
import { describe, expect, it } from "vitest";
import { ortSessionOptions } from "../src/ort-session-options.js";

describe("ortSessionOptions", () => {
  it.each([
    [1, 1],
    [2, 1],
    [4, 1],
    [12, 3],
    [64, 16],
  ])("cpuCount=%i -> intraOpNumThreads=%i when threads is undefined", (cpuCount, expected) => {
    const opts = ortSessionOptions(undefined, cpuCount);
    expect(opts.intraOpNumThreads).toBe(expected);
  });

  it("defaults interOpNumThreads to 1 when threads is undefined", () => {
    expect(ortSessionOptions(undefined, 12).interOpNumThreads).toBe(1);
  });

  it("disables intra-op and inter-op spinning by default", () => {
    const opts = ortSessionOptions(undefined, 12);
    expect(opts.extra.session.intra_op.allow_spinning).toBe("0");
    expect(opts.extra.session.inter_op.allow_spinning).toBe("0");
  });

  it("disables prepacking by default", () => {
    const opts = ortSessionOptions(undefined, 12);
    expect(opts.extra.session.disable_prepacking).toBe("1");
  });

  it("an explicit threads value wins for BOTH intra- and inter-op (pre-#995 behavior)", () => {
    const opts = ortSessionOptions(3, 64);
    expect(opts.intraOpNumThreads).toBe(3);
    expect(opts.interOpNumThreads).toBe(3);
  });

  it("still disables spinning when threads is explicit — not an opt-out of the spin fix", () => {
    const opts = ortSessionOptions(3, 64);
    expect(opts.extra.session.intra_op.allow_spinning).toBe("0");
    expect(opts.extra.session.inter_op.allow_spinning).toBe("0");
  });

  it("still disables prepacking when threads is explicit — not an opt-out of the prepacking fix", () => {
    const opts = ortSessionOptions(3, 64);
    expect(opts.extra.session.disable_prepacking).toBe("1");
  });
});
