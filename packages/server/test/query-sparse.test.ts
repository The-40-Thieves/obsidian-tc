import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings";
import { resolveQueryColbert, resolveQuerySparse } from "../src/tools/m7/query-sparse";

function provider(over: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "x",
    provider: "p",
    model: "m",
    dimensions: 2,
    embed: async (texts) => texts.map(() => [0, 0]),
    ...over,
  };
}

describe("resolveQuerySparse (serve-path sparse stream feed)", () => {
  it("returns the query sparse weights, encoded as a query, when enabled + embedFull present", async () => {
    let seenInput: string | undefined;
    const p = provider({
      embedFull: async (texts, opts) => {
        seenInput = opts?.input;
        return texts.map(() => ({ dense: [0, 0], sparse: { "7": 0.4 }, colbert: [] }));
      },
    });
    const qs = await resolveQuerySparse(p, "hello", true);
    expect(qs).toEqual({ "7": 0.4 });
    expect(seenInput).toBe("query");
  });

  it("returns undefined when disabled, without calling embedFull", async () => {
    let called = false;
    const p = provider({
      embedFull: async (texts) => {
        called = true;
        return texts.map(() => ({ dense: [], sparse: {}, colbert: [] }));
      },
    });
    expect(await resolveQuerySparse(p, "q", false)).toBeUndefined();
    expect(called).toBe(false);
  });

  it("returns undefined for a dense-only provider (no embedFull)", async () => {
    expect(await resolveQuerySparse(provider(), "q", true)).toBeUndefined();
  });
});

describe("resolveQueryColbert (serve-path ColBERT rerank feed)", () => {
  it("returns the query ColBERT matrix, encoded as a query, when enabled + embedFull present", async () => {
    let seenInput: string | undefined;
    const p = provider({
      embedFull: async (texts, opts) => {
        seenInput = opts?.input;
        return texts.map(() => ({
          dense: [0, 0],
          sparse: {},
          colbert: [
            [1, 0],
            [0, 1],
          ],
        }));
      },
    });
    const cb = await resolveQueryColbert(p, "hello", true);
    expect(cb).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(seenInput).toBe("query");
  });

  it("returns undefined when disabled or dense-only", async () => {
    expect(await resolveQueryColbert(provider(), "q", true)).toBeUndefined();
    let called = false;
    const p = provider({
      embedFull: async (t) => {
        called = true;
        return t.map(() => ({ dense: [], sparse: {}, colbert: [] }));
      },
    });
    expect(await resolveQueryColbert(p, "q", false)).toBeUndefined();
    expect(called).toBe(false);
  });
});
