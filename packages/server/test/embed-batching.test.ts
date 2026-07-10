// GH #172: embedPlans must cap each request by BOTH input count and estimated tokens, so a
// token-dense reconcile cannot pack ~87k tokens into one call and crash a stock local runner.
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings/provider";
import { embedPlans } from "../src/search/indexer";

function recordingProvider(): { provider: EmbeddingProvider; batches: string[][] } {
  const batches: string[][] = [];
  const provider: EmbeddingProvider = {
    id: "rec",
    provider: "rec",
    model: "m",
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      batches.push(texts);
      return texts.map(() => [0, 0]);
    },
  };
  return { provider, batches };
}

// Minimal NoteWritePlan carrying only what embedPlans reads (toEmbed[].content) and writes (vectors).
function planOf(contents: string[]) {
  return { toEmbed: contents.map((content) => ({ content })), vectors: [] as number[][] } as never;
}

const est = (s: string) => Math.ceil(s.length / 4);

describe("GH #172 embedPlans token budgeting", () => {
  it("splits a token-dense batch so no request exceeds maxBatchTokens", async () => {
    const { provider, batches } = recordingProvider();
    // 20 chunks x ~4000 chars = ~1000 est-tokens each; maxBatchTokens 8192 -> ~8 per request.
    const chunks = Array.from({ length: 20 }, (_, i) => "x".repeat(4000) + i);
    await embedPlans(provider, [planOf(chunks)], 512, 4, 8192);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.reduce((n, t) => n + est(t), 0)).toBeLessThanOrEqual(8192);
    }
    // Nothing dropped or reordered: every input embedded exactly once, in order.
    expect(batches.flat()).toEqual(chunks);
  });

  it("still caps by input count when tokens are small", async () => {
    const { provider, batches } = recordingProvider();
    const chunks = Array.from({ length: 10 }, (_, i) => `tiny${i}`);
    await embedPlans(provider, [planOf(chunks)], 4, 2, 8192);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(4);
    expect(batches.flat()).toEqual(chunks);
  });

  it("sends a single over-budget text alone rather than splitting or dropping it", async () => {
    const { provider, batches } = recordingProvider();
    const huge = "y".repeat(80000); // ~20k est-tokens; alone exceeds the 8192 cap
    const chunks = ["small-a", huge, "small-b"];
    await embedPlans(provider, [planOf(chunks)], 512, 4, 8192);
    expect(batches.flat()).toEqual(chunks);
    expect(batches.find((b) => b.includes(huge))).toEqual([huge]);
  });
});
