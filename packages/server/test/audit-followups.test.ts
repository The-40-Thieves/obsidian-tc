import { describe, expect, it } from "vitest";
import { assertVectors } from "../src/embeddings/provider";
import { evaluatesTruthy } from "../src/search/jsonlogic";
import { searchRegex } from "../src/search/text";

describe("audit follow-ups (regression)", () => {
  it("#4 searchRegex rejects quantified overlapping alternation (a|a)+", async () => {
    await expect(searchRegex("/no/such/root", { pattern: "(a|a)+", limit: 10 })).rejects.toThrow();
  });

  it("#4 searchRegex still rejects nested-quantifier classics, accepts safe patterns", async () => {
    await expect(searchRegex("/no/such/root", { pattern: "((a)+)+", limit: 10 })).rejects.toThrow();
    // a char class is the safe equivalent of (a|b)+ and must NOT be rejected by the guard
    await expect(searchRegex("/no/such/root", { pattern: "[ab]+", limit: 10 })).resolves.toEqual(
      [],
    );
  });

  it("#16 assertVectors rejects a non-finite component", () => {
    expect(() => assertVectors([[1, Number.NaN]], 2, 1)).toThrow();
    expect(() => assertVectors([[1, 2]], 2, 1)).not.toThrow();
  });

  it("#13 evaluatesTruthy rejects an over-nested jsonlogic expression", () => {
    let rule: Record<string, unknown> = { var: "x" };
    for (let i = 0; i < 80; i++) rule = { "!": [rule] };
    expect(() => evaluatesTruthy(rule, { x: 1 })).toThrow();
    expect(evaluatesTruthy({ "==": [1, 1] }, {})).toBe(true);
  });
});
