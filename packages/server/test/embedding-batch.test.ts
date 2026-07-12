import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings";
import { embedPlans } from "../src/search/indexer";

// Minimal NoteWritePlan shape embedPlans reads (toEmbed[].content) and writes (vectors).
type MinPlan = { toEmbed: { content: string }[]; vectors: number[][] };

function countingProvider(): { p: EmbeddingProvider; calls: () => number } {
  let calls = 0;
  const p: EmbeddingProvider = {
    id: "f",
    provider: "f",
    model: "m",
    dimensions: 2,
    embed: async (texts: string[]) => {
      calls++;
      return texts.map(() => [1, 0]);
    },
  };
  return { p, calls: () => calls };
}

describe("THE-277 embedPlans batching", () => {
  it("batches chunk embeds across plans by size cap and distributes vectors in order", async () => {
    const { p, calls } = countingProvider();
    const plans: MinPlan[] = [
      { toEmbed: [{ content: "a" }, { content: "b" }], vectors: [] },
      { toEmbed: [{ content: "c" }], vectors: [] },
    ];
    await embedPlans(p, plans as any, 2, 4); // 3 contents, cap 2 -> 2 sub-batches (not 3 per-note)
    expect(calls()).toBe(2);
    expect(plans[0]?.vectors).toHaveLength(2);
    expect(plans[1]?.vectors).toHaveLength(1);
  });

  it("no-ops when there is nothing to embed", async () => {
    const { p, calls } = countingProvider();
    const plans: MinPlan[] = [{ toEmbed: [], vectors: [] }];
    await embedPlans(p, plans as any, 512, 4);
    expect(calls()).toBe(0);
  });
});
