import { describe, it, expect } from "vitest";
import { ObsidianTcError, err } from "@obsidian-tc/shared";

describe("error taxonomy", () => {
  it("serializes to a stable JSON shape", () => {
    const e = new ObsidianTcError("forbidden", "nope", { required: ["write:notes"] });
    expect(e.toJSON()).toEqual({ code: "forbidden", message: "nope", retryable: false, details: { required: ["write:notes"] } });
  });
  it("marks transient codes retryable", () => {
    expect(new ObsidianTcError("throttled", "x").retryable).toBe(true);
    expect(new ObsidianTcError("internal", "x").retryable).toBe(true);
    expect(new ObsidianTcError("forbidden", "x").retryable).toBe(false);
  });
  it("factory helpers carry defaults and instanceof", () => {
    const e = err.elicitRequired();
    expect(e).toBeInstanceOf(ObsidianTcError);
    expect(e.code).toBe("elicit_required");
    expect(e.message.length).toBeGreaterThan(0);
  });
});
