import { err, ObsidianTcError, recoveryFor } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

describe("error taxonomy", () => {
  it("serializes to a stable JSON shape", () => {
    const e = new ObsidianTcError("forbidden", "nope", { required: ["write:notes"] });
    // THE-512 extended the envelope with `recovery`. Additive and optional: it appears only for
    // codes that have a hint, so a code mapped to null still serializes to the original four
    // fields. Compared against recoveryFor so this pins the wiring, not the wording.
    expect(e.toJSON()).toEqual({
      code: "forbidden",
      message: "nope",
      retryable: false,
      details: { required: ["write:notes"] },
      recovery: recoveryFor("forbidden"),
    });
  });
  it("omits recovery entirely for a code with no hint", () => {
    // Guards the `...(recovery ? {recovery} : {})` spread: a null-mapped code must not serialize
    // `recovery: undefined`, which would show up as a key in JSON round-trips.
    const withHint = new ObsidianTcError("forbidden", "x").toJSON();
    expect(Object.hasOwn(withHint, "recovery")).toBe(true);
    const codes = ["forbidden", "acl_denied", "throttled"] as const;
    for (const c of codes) {
      const json = new ObsidianTcError(c, "x").toJSON();
      // Every currently-mapped code has a string hint, never an undefined-valued key.
      expect(typeof json.recovery).toBe("string");
      expect(JSON.parse(JSON.stringify(json)).recovery).toBe(recoveryFor(c));
    }
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
