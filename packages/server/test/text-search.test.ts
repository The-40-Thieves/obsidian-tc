import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { searchRegex, searchText } from "../src/search/text";
import { makeM2Vault } from "./m2-helpers";

describe("searchText", () => {
  it("finds matching lines with 1-based line/col and a BM25 score", () => {
    const v = makeM2Vault({
      files: {
        "fox.md": "# Fox\n\nthe lazy dog sleeps",
        "rain.md": "# Rain\n\nstormy weather tonight",
      },
    });
    const hits = searchText(v.root, { query: "lazy", limit: 50 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("fox.md");
    expect(hits[0]?.line).toBe(3);
    expect(hits[0]?.col).toBe(5); // "the " then "lazy"
    expect(hits[0]?.score).toBeGreaterThan(0);
    v.cleanup();
  });

  it("honors whole_word", () => {
    const v = makeM2Vault({ files: { "a.md": "a dog runs\ndogma is strict" } });
    const loose = searchText(v.root, { query: "dog", limit: 50 });
    const strict = searchText(v.root, { query: "dog", wholeWord: true, limit: 50 });
    expect(loose.length).toBe(2);
    expect(strict.length).toBe(1);
    expect(strict[0]?.line).toBe(1);
    v.cleanup();
  });

  it("honors case_sensitive", () => {
    const v = makeM2Vault({ files: { "a.md": "Fox\nfox" } });
    const ci = searchText(v.root, { query: "Fox", limit: 50 });
    const cs = searchText(v.root, { query: "Fox", caseSensitive: true, limit: 50 });
    expect(ci.length).toBe(2);
    expect(cs.length).toBe(1);
    expect(cs[0]?.line).toBe(1);
    v.cleanup();
  });

  it("excludes files the read predicate rejects", () => {
    const v = makeM2Vault({
      files: { "pub.md": "shared secret word", "priv.md": "private secret word" },
    });
    const hits = searchText(v.root, {
      query: "secret",
      isReadable: (p) => p === "pub.md",
      limit: 50,
    });
    expect(hits.map((h) => h.path)).toEqual(["pub.md"]);
    v.cleanup();
  });
});

describe("searchRegex", () => {
  it("returns per-match line/col and caps at max_matches_per_file", async () => {
    const v = makeM2Vault({ files: { "a.md": "cat1 cat2 cat3 cat4" } });
    const hits = await searchRegex(v.root, { pattern: "cat\\d", maxPerFile: 2, limit: 50 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.match).toBe("cat1");
    expect(hits[0]?.line).toBe(1);
    v.cleanup();
  });

  it("throws invalid_input on an uncompilable pattern", async () => {
    const v = makeM2Vault({ files: { "a.md": "x" } });
    const p = searchRegex(v.root, { pattern: "(unclosed", limit: 10 });
    await expect(p).rejects.toBeInstanceOf(ObsidianTcError);
    await expect(p).rejects.toMatchObject({ code: "invalid_input" });
    v.cleanup();
  });

  it("times out a catastrophic pattern that slips the heuristic, then recovers (THE-293)", async () => {
    const v = makeM2Vault({ files: { "evil.md": `b${"a".repeat(64)}c` } });
    // hasNestedQuantifier passes: the (a|aa) groups are concatenated (no `)` is ever
    // immediately followed by `*` `+` or `{`), and the final group is followed by a
    // backreference. That trailing `\1` is load-bearing; do NOT "simplify" it away. A
    // backreference forces V8's Irregexp onto its plain backtracking interpreter, disabling
    // the memchr/Boyer-Moore fast-fail and min-length pruning. Without it, a trailing literal
    // (e.g. `...b`) lets V8 fast-fail in microseconds, so searchRegex resolves `[]` before the
    // 50ms budget and this `.rejects` flakes (engine/JIT/version sensitive). With it, the
    // exponential alternation fan-out backtracks every time and reliably exceeds 50ms (measured
    // ~1.1s warm / ~6s cold per exec), so the worker is terminated on overrun.
    const evil = `${"(a|aa)".repeat(22)}\\1c`;
    await expect(
      searchRegex(v.root, { pattern: evil, timeoutMs: 50, limit: 10 }),
    ).rejects.toMatchObject({ code: "compute_budget_exceeded" });
    // The worker was terminated; the next call lazily recreates it and succeeds.
    const hits = await searchRegex(v.root, { pattern: "a+", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    v.cleanup();
  }, 20_000);

  // THE-926: hasNestedQuantifier only looks at GROUPS, so a flat chain of bare quantified atoms
  // slips it entirely — `a*a*a*a*a*a*a*b` is measured exponential in V8 against a non-matching
  // input, with no group anywhere in the pattern. hasSequentialQuantifiers closes this gap.
  describe("hasSequentialQuantifiers guard (THE-926, amended after adversarial review)", () => {
    // Adversarial review of the first version of this guard found it flagged mere ADJACENCY of
    // 3+ quantified atoms, never checking whether their character classes actually overlap — the
    // real precondition for catastrophic backtracking — so it false-rejected safe, linear-time
    // patterns like `a+b+c+`. The fix requires the run to be the SAME atom repeated (raw source
    // text, exact match); every case below is checked directly against `searchRegex`, the way the
    // review verified the bug.
    it("REJECTS a run of 3+ identical adjacent quantified single-char atoms", async () => {
      const v = makeM2Vault({ files: { "a.md": "x" } });
      await expect(searchRegex(v.root, { pattern: "a*a*a*a*b", limit: 10 })).rejects.toMatchObject({
        code: "invalid_input",
      });
      v.cleanup();
    });

    it("REJECTS a run of 3+ identical adjacent quantified escaped-class atoms", async () => {
      const v = makeM2Vault({ files: { "a.md": "x" } });
      await expect(
        searchRegex(v.root, { pattern: "\\w+\\w+\\w+x", limit: 10 }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        searchRegex(v.root, { pattern: "\\s*\\s*\\s*$", limit: 10 }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      v.cleanup();
    });

    it("ADMITS disjoint-atom patterns that a mere-adjacency check false-rejected (THE-926 regression)", async () => {
      const v = makeM2Vault({ files: { "a.md": "aabbccc CamelCase123 3.14" } });
      const admitted = ["a+b+c+", "\\w+\\s+\\w+", "[A-Z]+[a-z]+\\d+", "\\d+\\.\\d+", "a+b+c+d+e+"];
      for (const pattern of admitted) {
        await expect(searchRegex(v.root, { pattern, limit: 10 })).resolves.toBeInstanceOf(Array);
      }
      v.cleanup();
    });

    it("the disjoint patterns above actually MATCH what they are supposed to (not just 'did not throw')", async () => {
      const v = makeM2Vault({ files: { "a.md": "aabbccc CamelCase123 3.14" } });
      expect((await searchRegex(v.root, { pattern: "a+b+c+", limit: 10 })).length).toBeGreaterThan(
        0,
      );
      expect(
        (await searchRegex(v.root, { pattern: "[A-Z]+[a-z]+\\d+", limit: 10 })).length,
      ).toBeGreaterThan(0);
      expect((await searchRegex(v.root, { pattern: "\\d+\\.\\d+", limit: 10 })).length).toBe(1);
      v.cleanup();
    });

    it("admitted disjoint-atom patterns are genuinely linear, not just no-longer-rejected", async () => {
      // `a+b+c+` against a long run of pure 'a' (never matching, since no 'b'/'c' follows) is the
      // adversarial shape for THIS pattern: if disjoint atoms still backtracked exponentially, an
      // ADMIT would just be moving the false-reject line rather than fixing the guard. Disjoint
      // character classes give the engine nothing to backtrack over, so this resolves in
      // milliseconds regardless of engine/worker-availability path.
      const v = makeM2Vault({ files: { "big.md": "a".repeat(20_000) } });
      const start = Date.now();
      const hits = await searchRegex(v.root, { pattern: "a+b+c+", timeoutMs: 2000, limit: 10 });
      const elapsed = Date.now() - start;
      expect(hits).toEqual([]);
      expect(elapsed).toBeLessThan(1500);
      v.cleanup();
    }, 10_000);

    it("a separator between quantified atoms resets the run — a date-shaped pattern is admitted", async () => {
      const v = makeM2Vault({ files: { "a.md": "2026-08-31" } });
      const hits = await searchRegex(v.root, { pattern: "\\d+-\\d+-\\d+", limit: 10 });
      expect(hits.length).toBeGreaterThan(0);
      v.cleanup();
    });

    it("still admits the repo's other real regex patterns (1-2 quantified atoms)", async () => {
      const v = makeM2Vault({ files: { "a.md": "cat1 la99 aaa [x]" } });
      for (const pattern of ["cat\\d", "la\\w+", "a+", "[ab]+", "a*b*"]) {
        await expect(searchRegex(v.root, { pattern, limit: 10 })).resolves.toBeInstanceOf(Array);
      }
      v.cleanup();
    });
  });
});
