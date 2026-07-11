// GH #172: embedPlans must cap each request by BOTH input count and estimated tokens, so a
// token-dense reconcile cannot pack ~87k tokens into one call and crash a stock local runner.
// THE-390: a provider REJECTION (HTTP 400 — batch over the model's loaded context) is bisected
// and retried; a text rejected even alone quarantines its plan instead of aborting the pass.
import { err, type ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings/provider";
import { embedPlans } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

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

// A provider with a REAL context cap: rejects (HTTP 400) any request whose summed est-tokens
// exceed ctxTokens — the Ollama n_ctx failure mode — and records only successful requests.
function contextCappedProvider(ctxTokens: number): {
  provider: EmbeddingProvider;
  state: { batches: string[][]; rejected: number };
} {
  const state = { batches: [] as string[][], rejected: 0 };
  const provider: EmbeddingProvider = {
    id: "capped",
    provider: "capped",
    model: "m",
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.reduce((n, t) => n + est(t), 0) > ctxTokens) {
        state.rejected += 1;
        throw err.embeddingProviderError("HTTP 400", { provider: "capped", status: 400 });
      }
      state.batches.push(texts);
      return texts.map((t) => [t.length, 0]);
    },
  };
  return { provider, state };
}

describe("THE-390 embed rejection resilience", () => {
  it("bisects a rejected batch and retries until it fits the provider's real context", async () => {
    // maxBatchTokens (2000) sits ABOVE the provider's real cap (1200) — the chars/4 estimate
    // undercount in miniature. Packed batches overshoot, 400, and must bisect + retry.
    const { provider, state } = contextCappedProvider(1200);
    const chunks = Array.from({ length: 8 }, (_, i) => "x".repeat(2000) + i); // ~500 est each
    const plan = planOf(chunks) as { toEmbed: unknown[]; vectors: number[][] };
    const report = await embedPlans(provider, [plan] as never, 512, 1, 2000);
    expect(report.failed).toEqual([]);
    expect(report.rejections).toBe(state.rejected);
    expect(state.rejected).toBeGreaterThan(0);
    // Every text embedded exactly once, in order, and no successful request over the real cap.
    expect(state.batches.flat()).toEqual(chunks);
    for (const b of state.batches) {
      expect(b.reduce((n, t) => n + est(t), 0)).toBeLessThanOrEqual(1200);
    }
    // Vectors landed on the plan aligned to its chunks.
    expect(plan.vectors.map((v) => v[0])).toEqual(chunks.map((c) => c.length));
  });

  it("quarantines a text rejected even alone and fails only that plan", async () => {
    const poison = "POISON";
    const provider: EmbeddingProvider = {
      id: "capped",
      provider: "capped",
      model: "m",
      dimensions: 2,
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.some((t) => t.includes(poison)))
          throw err.embeddingProviderError("HTTP 400", { provider: "capped", status: 400 });
        return texts.map((t) => [t.length, 0]);
      },
    };
    const good = planOf(["ok-1", "ok-2"]) as { vectors: number[][] };
    const bad = planOf(["ok-3", poison]) as { vectors: number[][] };
    const report = await embedPlans(provider, [good, bad] as never, 512, 1, 8192);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toBe(bad);
    // The good plan embedded fully; the failed plan's vectors stay empty (must not be applied).
    expect(good.vectors).toHaveLength(2);
    expect(bad.vectors).toHaveLength(0);
  });

  it("propagates non-rejection errors — a dead backend still aborts the pass", async () => {
    const provider: EmbeddingProvider = {
      id: "down",
      provider: "down",
      model: "m",
      dimensions: 2,
      async embed(): Promise<number[][]> {
        throw err.embeddingProviderError("HTTP 500", { provider: "down", status: 500 });
      },
    };
    await expect(embedPlans(provider, [planOf(["a", "b"])], 512, 1, 8192)).rejects.toThrow(
      "HTTP 500",
    );
  });
});

describe("THE-390 reconcile survives a quarantined note (index_vault)", () => {
  it("skips the rejected note, indexes the rest, and reports notes_embed_failed", async () => {
    const poison = "POISON-OVER-CONTEXT";
    const provider: EmbeddingProvider = {
      id: "capped",
      provider: "capped",
      model: "m",
      dimensions: 32,
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.some((t) => t.includes(poison)))
          throw err.embeddingProviderError("HTTP 400", { provider: "capped", status: 400 });
        return texts.map(() => Array.from({ length: 32 }, () => 0.5));
      },
    };
    const v = makeM2Vault({
      files: { "ok.md": "# OK\n\na perfectly fine body", "bad.md": `# Bad\n\n${poison} body` },
      provider,
    });
    const res: ToolResult = await v.call("index_vault", { vault: "test" });
    expect(res.ok).toBe(true);
    const d = (res.ok ? res.data : {}) as Record<string, number>;
    expect(d.notes_embed_failed).toBe(1);
    expect(d.chunks_upserted).toBe(1);
    const paths = (
      v.db.prepare("SELECT DISTINCT path FROM chunks").all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(paths).toEqual(["ok.md"]);
    v.cleanup();
  });
});
