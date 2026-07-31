// The shared evidence builder. Two surfaces used to render evidence their own way — reflect.ts's
// synthesis path at 20 items / 800 chars, plane/challenge.ts's renderEvidence at no cap / 1800
// chars — and neither deduplicated, quota-limited or budgeted anything. Both numbered with `[n]`, so
// same citation convention meant a 2.25x different amount of source text depending on which tool
// the caller reached.
//
// These tests pin the mechanics that were missing, not the selection policy (rank order in is rank
// order out — see the module header for why choosing evidence differently is a gated retrieval
// change, not a refactor).
import { describe, expect, it } from "vitest";
import {
  buildEvidence,
  type EvidenceSource,
  renderEvidenceItem,
  trimToBoundary,
} from "../src/search/evidence";

const src = (path: string, content: string, chunkId?: string): EvidenceSource =>
  chunkId === undefined ? { path, content } : { path, content, chunkId };

const BUDGET = { maxItems: 10, maxCharsPerItem: 100 };

describe("evidence set construction", () => {
  it("preserves rank order", () => {
    const out = buildEvidence([src("c.md", "3"), src("a.md", "1"), src("b.md", "2")], BUDGET);
    expect(out.items.map((i) => i.path)).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("numbers citations 1..n contiguously, AFTER drops", () => {
    // The failure this prevents: numbering candidates before dropping any leaves `[7]` referring
    // to an item the model was never shown.
    const out = buildEvidence(
      [
        src("a.md", "one", "c1"),
        src("a.md", "one", "c1"), // duplicate — dropped
        src("b.md", "two", "c2"),
      ],
      BUDGET,
    );
    expect(out.items.map((i) => i.citation)).toEqual([1, 2]);
    expect(out.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
  });

  it("deduplicates by chunk id, whatever else differs", () => {
    const out = buildEvidence(
      [src("a.md", "body", "c1"), src("elsewhere.md", "different text", "c1")],
      BUDGET,
    );
    expect(out.items).toHaveLength(1);
    expect(out.stats.droppedDuplicate).toBe(1);
  });

  it("deduplicates a repeated note body reachable under two paths", () => {
    // No chunk id, same content: a copy or an alias. Counting it twice inflates apparent support
    // for whatever it says — the model sees "two sources agree" about one source.
    const out = buildEvidence([src("a.md", "identical"), src("copy/a.md", "identical")], BUDGET);
    expect(out.items).toHaveLength(2); // different paths => different keys
    const same = buildEvidence([src("a.md", "identical"), src("a.md", "identical")], BUDGET);
    expect(same.items).toHaveLength(1);
    expect(same.stats.droppedDuplicate).toBe(1);
  });

  it("length-prefixes the dedup key so adjacent fields cannot collide", () => {
    // {path:"ab", content:"c"} and {path:"a", content:"bc"} concatenate identically without
    // length prefixes — the same collision rule hash.ts applies to cache keys.
    const out = buildEvidence([src("ab", "c"), src("a", "bc")], BUDGET);
    expect(out.items).toHaveLength(2);
    expect(out.stats.droppedDuplicate).toBe(0);
  });

  it("enforces a per-note quota so one chunked note cannot own the context", () => {
    const many = Array.from({ length: 8 }, (_, i) => src("big.md", `chunk ${i}`, `c${i}`));
    const out = buildEvidence([...many, src("other.md", "other", "z")], {
      ...BUDGET,
      maxPerNote: 2,
    });
    expect(out.items.filter((i) => i.path === "big.md")).toHaveLength(2);
    expect(out.items.map((i) => i.path)).toContain("other.md");
    expect(out.stats.droppedPerNoteQuota).toBe(6);
  });

  it("leaves room for other notes when one note dominates the candidates", () => {
    // The quota's actual job. Without it, big.md's 6 chunks take the whole maxItems=3 cap and
    // other.md is never seen. NOTE this does not depend on filter ORDER — each filter is a
    // `continue`, so an item is kept iff it passes all of them. See the next test for the one
    // property that is order-dependent.
    const candidates = [
      ...Array.from({ length: 6 }, (_, i) => src("big.md", `c${i}`, `b${i}`)),
      src("other.md", "kept", "o1"),
    ];
    const withQuota = buildEvidence(candidates, {
      maxItems: 3,
      maxCharsPerItem: 100,
      maxPerNote: 1,
    });
    expect(withQuota.items.map((i) => i.path)).toEqual(["big.md", "other.md"]);

    const withoutQuota = buildEvidence(candidates, { maxItems: 3, maxCharsPerItem: 100 });
    expect(withoutQuota.items.map((i) => i.path)).toEqual(["big.md", "big.md", "big.md"]);
  });

  it("attributes an over-quota drop to the quota, not the item cap", () => {
    // The ONE order-dependent property. When a candidate fails both the quota and a full item cap,
    // whichever check runs first is credited. Quota first is deliberate: "this note is over its
    // share" is a note-shape fact a caller can act on, where "the set was full" is not.
    // Reversing the two checks in evidence.ts flips this counter and nothing else.
    const out = buildEvidence([src("a.md", "one", "c1"), src("a.md", "two", "c2")], {
      maxItems: 1,
      maxCharsPerItem: 100,
      maxPerNote: 1,
    });
    expect(out.items).toHaveLength(1);
    expect(out.stats.droppedPerNoteQuota).toBe(1);
    expect(out.stats.droppedItemCap).toBe(0);
  });

  it("counts every remaining candidate when the character budget stops the set", () => {
    // A stop, not a skip: letting a later shorter chunk squeeze in would make the set depend on
    // chunk sizes rather than on rank.
    const out = buildEvidence(
      [src("a.md", "x".repeat(60)), src("b.md", "y".repeat(60)), src("c.md", "z")],
      { maxItems: 10, maxCharsPerItem: 100, maxTotalChars: 100 },
    );
    expect(out.items.map((i) => i.path)).toEqual(["a.md"]);
    expect(out.stats.droppedCharBudget).toBe(2); // b.md and c.md, including the one that tripped it
  });

  it("reports the true candidate count, not just what survived", () => {
    const out = buildEvidence(
      Array.from({ length: 25 }, (_, i) => src(`n${i}.md`, "body", `c${i}`)),
      { maxItems: 5, maxCharsPerItem: 100 },
    );
    expect(out.stats.candidates).toBe(25);
    expect(out.items).toHaveLength(5);
    expect(out.stats.droppedItemCap).toBe(20);
  });
});

describe("coverage flags", () => {
  it("flags missing evidence on an empty set — distinct from low coverage", () => {
    const out = buildEvidence([], BUDGET);
    expect(out.missingEvidence).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("does not flag low coverage when everything fit", () => {
    const out = buildEvidence([src("a.md", "one"), src("b.md", "two")], BUDGET);
    expect(out.missingEvidence).toBe(false);
    expect(out.lowCoverage).toBe(false);
  });

  it("flags low coverage when the item cap dropped candidates", () => {
    const out = buildEvidence([src("a.md", "1"), src("b.md", "2"), src("c.md", "3")], {
      maxItems: 2,
      maxCharsPerItem: 100,
    });
    expect(out.lowCoverage).toBe(true);
  });

  it("flags low coverage below an explicit floor even with nothing dropped", () => {
    const out = buildEvidence([src("a.md", "only")], { ...BUDGET, lowCoverageBelow: 3 });
    expect(out.stats.droppedItemCap).toBe(0);
    expect(out.lowCoverage).toBe(true);
  });
});

describe("boundary-aware trimming", () => {
  it("prefers a paragraph break over a mid-sentence cut", () => {
    const content = `${"a".repeat(80)}\n\n${"b".repeat(80)}`;
    const out = trimToBoundary(content, 100);
    expect(out).toBe("a".repeat(80));
    expect(out.endsWith("a")).toBe(true);
  });

  it("falls back to a line break when there is no paragraph break", () => {
    const content = `${"a".repeat(80)}\n${"b".repeat(80)}`;
    expect(trimToBoundary(content, 100)).toBe("a".repeat(80));
  });

  it("cuts hard when the content has no boundary at all", () => {
    // A minified or single-line note has nothing to find and must still be trimmed — the fallback
    // is what stops a boundary search from returning the whole string.
    const content = "a".repeat(500);
    expect(trimToBoundary(content, 100)).toHaveLength(100);
  });

  it("ignores a boundary too near the start, so trimming cannot collapse a chunk", () => {
    // Boundary at index 5 of a 100-char allowance: honouring it would return 5 characters and call
    // that an excerpt. The search floor (75% of the limit) is what prevents that.
    const content = `abcde\n\n${"z".repeat(400)}`;
    expect(trimToBoundary(content, 100)).toHaveLength(100);
  });

  it("returns short content untouched and handles a zero limit", () => {
    expect(trimToBoundary("short", 100)).toBe("short");
    expect(trimToBoundary("anything", 0)).toBe("");
  });

  it("marks trimmed items as truncated, and untrimmed ones as not", () => {
    const out = buildEvidence([src("a.md", "x".repeat(500)), src("b.md", "tiny")], BUDGET);
    expect(out.items[0]?.truncated).toBe(true);
    expect(out.items[1]?.truncated).toBe(false);
  });
});

describe("rendering", () => {
  it("emits the [n] path/headings/tags/content shape both former call sites used", () => {
    const out = buildEvidence(
      [{ path: "a.md", content: "body", headings: ["H1", "H2"], tags: ["t1", "t2"] }],
      BUDGET,
    );
    const rendered = renderEvidenceItem(out.items[0] as never);
    expect(rendered).toContain("[1] path: a.md");
    expect(rendered).toContain("headings: H1 > H2");
    expect(rendered).toContain("tags: t1, t2");
    expect(rendered).toContain("content: body");
    expect(rendered).not.toContain("[truncated]");
  });

  it("omits absent headings/tags rather than rendering empty labels", () => {
    const out = buildEvidence([src("a.md", "body")], BUDGET);
    const rendered = renderEvidenceItem(out.items[0] as never);
    expect(rendered).not.toContain("headings:");
    expect(rendered).not.toContain("tags:");
  });

  it("marks a truncated excerpt so a caller cannot imply the model saw the whole note", () => {
    const out = buildEvidence([src("a.md", "x".repeat(500))], BUDGET);
    expect(renderEvidenceItem(out.items[0] as never)).toContain("[truncated]");
  });
});
