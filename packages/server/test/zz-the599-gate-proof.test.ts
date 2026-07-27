// THE-599 GATE PROOF -- THROWAWAY, DO NOT MERGE.
//
// Deliberately failing assertion. Its only job is to make `build-test` red so we can confirm that
// branch protection now actually blocks the merge. Before this ticket, main required 19 checks and
// none of them ran the test suite, so a PR failing hundreds of assertions was mergeable.
//
// A required check whose context name never matches reads as "Expected" forever OR is silently
// ignored -- either way it proves nothing. The only way to know the gate works is to watch it fail.
import { describe, expect, it } from "vitest";

describe("THE-599 required-check proof", () => {
  it("fails on purpose so branch protection can be observed blocking the merge", () => {
    expect(1).toBe(2);
  });
});
