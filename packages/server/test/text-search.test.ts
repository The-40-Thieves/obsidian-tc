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
});
