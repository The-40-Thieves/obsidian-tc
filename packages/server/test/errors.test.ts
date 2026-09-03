import {
  err,
  isLoudRefusal,
  ObsidianTcError,
  recoveryFor,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { EgressViolationError } from "../src/plane/egress-filter";

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

// THE-926: multi_query.ts and federated_search.ts's per-leg fan-out isolation must rethrow a
// deliberate/structural refusal (chunk_fts.ts's THE-750 guard) rather than swallowing it into
// "this leg found nothing" — isLoudRefusal is the predicate that draws that line.
describe("isLoudRefusal (THE-926 fan-out swallow guard)", () => {
  it("is true for code 'internal' even though the taxonomy marks it retryable", () => {
    // The premise a naive `!e.retryable` predicate would get wrong: THE-750's refusal throws
    // `err.internal(...)`, and `internal` IS in RETRYABLE (a generic "unexpected failure, worth
    // one retry" default) — yet re-running the SAME query re-hits the same table shape and
    // refuses identically every time, so it must still be treated as loud.
    const e = err.internal("pre-THE-711 chunk_fts shape");
    expect(e.retryable).toBe(true);
    expect(isLoudRefusal(e)).toBe(true);
  });

  it("is true for a non-retryable domain-specific code (e.g. a THE-293 ReDoS budget refusal)", () => {
    expect(isLoudRefusal(err.computeBudgetExceeded("x"))).toBe(true);
    expect(isLoudRefusal(err.validation("bad input"))).toBe(true);
    expect(isLoudRefusal(err.contentRejected("x"))).toBe(true);
  });

  // THE-934 fix round 3 (H): EgressViolationError used to extend a bare Error, so a per-leg
  // fan-out isolation layer with no EXPLICIT `instanceof EgressViolationError` check of its own
  // (unlike cli/commands/index.ts's rethrow, or fix round 3, B's content-bearing catches) would
  // silently swallow a guard refusal into "this leg found nothing" via isLoudRefusal alone.
  it("is true for EgressViolationError — the port guard's refusal must not be swallowed by a fan-out with no explicit check of its own", () => {
    const e = new EgressViolationError("egress guard: extract request carries no sourcePaths");
    expect(e).toBeInstanceOf(ObsidianTcError);
    expect(e.code).toBe("egress_excluded");
    expect(e.retryable).toBe(false);
    expect(isLoudRefusal(e)).toBe(true);
  });

  it("is false for the domain-specific codes a fan-out leg may legitimately swallow", () => {
    // These ARE retryable AND not the generic "internal" bucket — a genuine per-leg transient
    // hiccup (embedding backend, a timeout, an unreachable plugin, ...) that must not sink the
    // whole fan-out call.
    for (const code of [
      "embedding_provider_error",
      "operation_timeout",
      "plugin_unreachable",
      "concurrent_modification",
      "idempotency_in_flight",
      "throttled",
      "aborted",
    ] as const) {
      const e = new ObsidianTcError(code, "x");
      expect(e.retryable).toBe(true);
      expect(isLoudRefusal(e)).toBe(false);
    }
  });

  it("is false for a bare Error or any other non-ObsidianTcError throw", () => {
    expect(isLoudRefusal(new Error("boom"))).toBe(false);
    expect(isLoudRefusal("boom")).toBe(false);
    expect(isLoudRefusal(undefined)).toBe(false);
  });
});
