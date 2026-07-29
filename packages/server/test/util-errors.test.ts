// THE-625 items 1-2: errorMessage/stderrOnError collapse the repeated
// `e instanceof Error ? e.message : String(e)` ternary and its `onError: (e) => process.stderr.write`
// wrapper, both duplicated across cli.ts's boot wiring. Covering the non-Error branch matters most:
// it is the one a naive `(e as Error).message` gets wrong, and the one this repo has been bitten by
// before (a failure encoded as a valid domain value is invisible in exactly this shape).
import { describe, expect, it, vi } from "vitest";
import { errorMessage, stderrOnError } from "../src/util/errors";

describe("errorMessage", () => {
  it("reads .message off a real Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a thrown non-Error value instead of crashing", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
  });

  it("subclasses of Error still take the .message branch", () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError("custom"))).toBe("custom");
  });
});

describe("stderrOnError", () => {
  it("writes `[tag] message` for an Error", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      stderrOnError("retrieval-log")(new Error("db locked"));
      expect(write).toHaveBeenCalledWith("[retrieval-log] db locked\n");
    } finally {
      write.mockRestore();
    }
  });

  it("degrades a non-Error throw to its stringified form, never throwing itself", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => stderrOnError("episodes")("disk full")).not.toThrow();
      expect(write).toHaveBeenCalledWith("[episodes] disk full\n");
    } finally {
      write.mockRestore();
    }
  });
});
