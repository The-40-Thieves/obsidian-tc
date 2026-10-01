// The helpers behind eval/query-cache.ts. The harness's claims (repeat fraction, identity naming,
// the restricted caller really being restricted) rest on these, so they are pinned here rather than
// trusted from one run's output.
import { describe, expect, it } from "vitest";
import {
  buildStream,
  differingKeys,
  foldersCovering,
  MAX_REPEAT_GAP,
  median,
  quantile,
  summarize,
  underFolders,
} from "../eval/query-cache-lib";

describe("buildStream", () => {
  it("is reproducible from its seed and differs across seeds", () => {
    expect(buildStream(250, 0.3, 7)).toEqual(buildStream(250, 0.3, 7));
    expect(buildStream(250, 0.3, 7)).not.toEqual(buildStream(250, 0.3, 8));
  });

  it.each([
    [0, 250],
    [0.1, 278],
    [0.3, 358],
  ])(
    "rate %s: exactly %i calls, every distinct query asked first, repeats only after",
    (r, len) => {
      const stream = buildStream(250, r, 20260930);
      expect(stream).toHaveLength(len);
      const seen = new Set<number>();
      let repeats = 0;
      for (const call of stream) {
        if (call.repeat) {
          repeats++;
          expect(seen.has(call.query)).toBe(true);
        } else {
          expect(seen.has(call.query)).toBe(false);
        }
        seen.add(call.query);
      }
      expect(seen.size).toBe(250);
      expect(repeats).toBe(len - 250);
      expect(repeats / len).toBeGreaterThanOrEqual(r);
      expect(repeats / len).toBeLessThan(r + 0.01);
    },
  );

  it("never lets a repeat reach further back than the LRU window", () => {
    const stream = buildStream(250, 0.3, 20260930);
    const lastAsked = new Map<number, number>();
    stream.forEach((call, p) => {
      if (call.repeat) {
        const prev = lastAsked.get(call.query) as number;
        expect(p - prev).toBeLessThanOrEqual(MAX_REPEAT_GAP);
      }
      lastAsked.set(call.query, p);
    });
  });

  it("rejects an impossible rate", () => {
    expect(() => buildStream(10, 1, 1)).toThrow();
    expect(() => buildStream(0, 0.1, 1)).toThrow();
  });
});

describe("summaries", () => {
  it("uses nearest-rank quantiles", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(s, 0.5)).toBe(5);
    expect(quantile(s, 0.95)).toBe(10);
    expect(median([9, 1, 5])).toBe(5);
    expect(summarize([4, 2, 6])).toEqual({ n: 3, p50: 4, p95: 6, mean: 4 });
    expect(summarize([]).n).toBe(0);
  });
});

describe("differingKeys", () => {
  it("names the top-level keys that differ, and nothing when the responses are equal", () => {
    const a = { vault: "v", results: [1, 2], coverage: { n: 1 } };
    expect(differingKeys(a, structuredClone(a))).toEqual([]);
    const { coverage: _dropped, ...hit } = a;
    expect(differingKeys(a, hit)).toEqual(["coverage"]);
    expect(differingKeys(a, { ...a, results: [2, 1] })).toEqual(["results"]);
  });
});

describe("restricted-caller folders", () => {
  const counts = new Map([
    ["a/one.md", 10],
    ["a/two.md", 10],
    ["b/x.md", 30],
    ["c/y.md", 40],
    ["root.md", 10],
  ]);

  it("covers the requested fraction without ever covering everything", () => {
    expect(foldersCovering(counts, 0.2)).toEqual(["a"]);
    expect(foldersCovering(counts, 0.5)).toEqual(["a", "b"]);
    expect(foldersCovering(counts, 1)).toEqual(["a", "b"]);
  });

  it("matches only paths under a covered folder", () => {
    expect(underFolders("a/one.md", ["a"])).toBe(true);
    expect(underFolders("ab/one.md", ["a"])).toBe(false);
    expect(underFolders("root.md", ["a", "b"])).toBe(false);
  });
});
