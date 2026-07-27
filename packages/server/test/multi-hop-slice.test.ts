// THE-652 — the synthetic multi-hop slice that replaces what THE-421 purged.
//
// These tests exist because a generator bug is INVISIBLE downstream. A slice that quietly emitted
// direct seed→target edges, or reused a "distinctive" term across many notes, would make every A/B
// built on it measure nothing while every eval run looked perfectly healthy — and the tickets
// blocked on this (THE-651, THE-629) would then ship on a null meaning "not measured" rather than
// "no effect", which is the exact failure feedback-state-the-detectable-effect-before-running
// describes.
import { describe, expect, it } from "vitest";
import {
  assertSliceInvariants,
  DEFAULT_QUERIES,
  DEFAULT_SEED,
  generateSlice,
  toYaml,
} from "../eval/gen-multi-hop-slice";

describe("multi-hop slice — size is derived from the MDE, not chosen", () => {
  it("defaults to a size that can detect the smallest effect worth shipping", () => {
    // MDE scales ~1/sqrt(n) from a measured 0.037 at n=136, so n ≈ 136·(0.037/d)².
    // THE-448 measured unconditional fan-out at −0.047; a conditional variant must beat that by a
    // comparable margin, so d≈0.05 (n≈75) is the floor and d≈0.04 (n≈117) is the target.
    expect(DEFAULT_QUERIES).toBeGreaterThanOrEqual(117);
    const mdeAt = (n: number) => 0.037 * Math.sqrt(136 / n);
    expect(mdeAt(DEFAULT_QUERIES)).toBeLessThan(0.05); // can see the bar THE-448 set
  });

  it("REFUSES a slice too small to conclude anything", () => {
    // Emitting an underpowered slice is worse than emitting none: it produces nulls that read as
    // "no effect" when they mean "below resolution".
    const tiny = generateSlice(20, DEFAULT_SEED);
    const report = assertSliceInvariants(tiny);
    expect(report.violations.some((v) => v.includes("MDE floor"))).toBe(true);
  });

  it("asserts its own count, so a truncated or stale copy fails loudly", () => {
    // Constraint 4 — the n=136-vs-250 stale-copy trap, applied to this slice.
    const slice = generateSlice();
    expect(slice.queries).toHaveLength(DEFAULT_QUERIES);
    expect(assertSliceInvariants(slice).queryCount).toBe(DEFAULT_QUERIES);
  });
});

describe("multi-hop slice — the topology IS the measurement", () => {
  const slice = generateSlice();
  const byPath = new Map(slice.notes.map((n) => [n.path, n]));

  it("passes every construction invariant", () => {
    const report = assertSliceInvariants(slice);
    expect(report.violations).toEqual([]);
    expect(report.noteCount).toBeGreaterThan(DEFAULT_QUERIES * 2); // floor: a real corpus, not stubs
  });

  it("has NO direct seed→target edge — without this it is not multi-hop at all", () => {
    // The single property the whole slice exists to create. A retriever doing one hop from the seed
    // reaches the bridge and stops; the target needs the second step.
    for (const q of slice.queries) {
      const seed = byPath.get(q.seed_paths[0] as string);
      expect(seed?.links).not.toContain(q.target_paths[0]);
    }
  });

  it("has a real 2-step chain for every query", () => {
    for (const q of slice.queries) {
      const seed = byPath.get(q.seed_paths[0] as string);
      const bridge = byPath.get(q.bridge_paths[0] as string);
      expect(seed?.links).toContain(q.bridge_paths[0]);
      expect(bridge?.links).toContain(q.target_paths[0]);
    }
  });

  it("keeps bridge degree in 2..20 — degree 1 is a rename, not a hop", () => {
    // A bridge with one inbound and one outbound edge is indistinguishable from a direct link, so
    // graph expansion would reach the target for free and the query would stop being multi-hop.
    for (const q of slice.queries) {
      const degree = byPath.get(q.bridge_paths[0] as string)?.links.length ?? 0;
      expect(degree).toBeGreaterThanOrEqual(2);
      expect(degree).toBeLessThanOrEqual(20);
    }
  });

  it("crosses domains — seed and target never share one", () => {
    for (const q of slice.queries) expect(q.seed_domain).not.toBe(q.target_domain);
  });

  it("keeps each distinctive term to at most two notes vault-wide", () => {
    // What makes the lexical arm a signal rather than a term-frequency artifact.
    const terms = slice.queries.map((q) => /the (\S+) procedure/.exec(q.query_text)?.[1]);
    const sampled = terms.filter((t): t is string => Boolean(t)).slice(0, 25);
    expect(sampled.length).toBeGreaterThan(20); // floor: the regex actually extracted terms
    for (const term of sampled) {
      expect(slice.notes.filter((n) => n.content.includes(term))).toHaveLength(2);
    }
  });
});

describe("multi-hop slice — reproducible and leak-free by construction", () => {
  it("is deterministic for a seed, which is what lets the corpus stay out of the repo", () => {
    expect(toYaml(generateSlice(30, 7).queries)).toBe(toYaml(generateSlice(30, 7).queries));
  });

  it("differs for a different seed, so 'deterministic' is not 'constant'", () => {
    expect(toYaml(generateSlice(30, 7).queries)).not.toBe(toYaml(generateSlice(30, 8).queries));
  });

  it("emits only minted content — no real vault paths can appear", () => {
    // Constraint 1: survives `vault leak (structural)` BY CONSTRUCTION. Every path is
    // <domain>/<Role> <n>.md from a fixed 8-word domain list, so there is no curation step where
    // real content could enter.
    const slice = generateSlice(40, DEFAULT_SEED);
    for (const n of slice.notes) {
      expect(n.path).toMatch(
        /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta)\/[A-Za-z]+ [\w-]+\.md$/,
      );
    }
  });

  it("renders YAML in the documented shape", () => {
    const yaml = toYaml(generateSlice(3, DEFAULT_SEED).queries);
    expect(yaml).toContain("queries:");
    expect(yaml).toMatch(/ {2}- id: mh-0/);
    for (const key of [
      "query_text",
      "seed_domain",
      "target_domain",
      "seed_paths",
      "target_paths",
      "bridge_paths",
    ]) {
      expect(yaml).toContain(key);
    }
  });
});
