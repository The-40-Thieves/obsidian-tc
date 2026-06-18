import { describe, expect, it } from "vitest";
import { chunkNote, estimateTokens } from "../src/search/chunk";

describe("chunkNote", () => {
  it("returns no chunks for an empty body", () => {
    expect(chunkNote("")).toEqual([]);
    expect(chunkNote("   \n\n  ")).toEqual([]);
  });

  it("keeps a short single-heading note as one chunk with its breadcrumb", () => {
    const out = chunkNote("# Title\n\nHello world.");
    expect(out).toHaveLength(1);
    expect(out[0]?.headings).toEqual(["Title"]);
    expect(out[0]?.content).toBe("Hello world.");
    expect(out[0]?.tokenCount).toBeGreaterThan(0);
    expect(out[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates preamble from headed sections", () => {
    const out = chunkNote("intro line\n\n# A\n\nbody a\n\n# B\n\nbody b");
    expect(out.map((c) => c.content)).toEqual(["intro line", "body a", "body b"]);
    expect(out.map((c) => c.headings)).toEqual([[], ["A"], ["B"]]);
  });

  it("builds nested heading breadcrumbs", () => {
    const out = chunkNote("# H1\n\ntop\n\n## H2\n\nnested");
    expect(out.map((c) => c.headings)).toEqual([["H1"], ["H1", "H2"]]);
  });

  it("does not treat '#' inside a fenced code block as a heading", () => {
    const out = chunkNote("# Real\n\n```\n# not a heading\ncode\n```\n\nafter");
    expect(out).toHaveLength(1);
    expect(out[0]?.headings).toEqual(["Real"]);
    expect(out[0]?.content).toContain("# not a heading");
  });

  it("sub-splits a section over the token budget into k.i chunks sharing the breadcrumb", () => {
    const para = (n: number) => `${"word ".repeat(40)}p${n}`;
    const body = `# Big\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}`;
    const out = chunkNote(body, { maxTokens: 60 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((c) => c.headings[0] === "Big")).toBe(true);
    expect(out.every((c) => /^1\.\d+$/.test(c.index))).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("is positive and grows with length", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});
