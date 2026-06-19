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
  it("returns per-match line/col and caps at max_matches_per_file", () => {
    const v = makeM2Vault({ files: { "a.md": "cat1 cat2 cat3 cat4" } });
    const hits = searchRegex(v.root, { pattern: "cat\\d", maxPerFile: 2, limit: 50 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.match).toBe("cat1");
    expect(hits[0]?.line).toBe(1);
    v.cleanup();
  });

  it("throws invalid_input on an uncompilable pattern", () => {
    const v = makeM2Vault({ files: { "a.md": "x" } });
    try {
      searchRegex(v.root, { pattern: "(unclosed", limit: 10 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("invalid_input");
    }
    v.cleanup();
  });
});
