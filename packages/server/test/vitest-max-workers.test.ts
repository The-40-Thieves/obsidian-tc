import { describe, expect, it } from "vitest";
import { resolveVitestMaxWorkers } from "./vitest-max-workers";

describe("vitest max worker resolution", () => {
  it("keeps Vitest's default worker count in CI when no override is set", () => {
    expect(resolveVitestMaxWorkers({ CI: "true" })).toBeUndefined();
  });

  it("caps local runs at two workers when no override is set", () => {
    expect(resolveVitestMaxWorkers({})).toBe(2);
  });

  it("uses a positive integer override", () => {
    expect(resolveVitestMaxWorkers({ CI: "true", VITEST_MAX_WORKERS: "2" })).toBe(2);
  });

  it("rejects an invalid override", () => {
    expect(() => resolveVitestMaxWorkers({ CI: "true", VITEST_MAX_WORKERS: "many" })).toThrow(
      'VITEST_MAX_WORKERS must be a positive integer, got "many"',
    );
  });
});
