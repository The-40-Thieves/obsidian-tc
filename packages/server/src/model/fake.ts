// Deterministic in-process ModelClient / GenerationClient for tests and offline runs, mirroring
// embeddings/fake.ts. No network and no models: outputs are a stable function of the input text.
import { deterministicVector } from "../embeddings/fake";
import type {
  CompletionRequest,
  CompletionResult,
  EmbedFullResult,
  EmbedRequest,
  EmbedResult,
  GenerationClient,
  ModelClient,
  RerankRequest,
  RerankResult,
} from "./ports";

export function fakeModelClient(opts: { model?: string; dimensions?: number } = {}): ModelClient {
  const model = opts.model ?? "fake/embed";
  const dimensions = opts.dimensions ?? 8;
  return {
    embed(req: EmbedRequest): Promise<EmbedResult> {
      return Promise.resolve({
        model,
        revision: "fake",
        vectors: req.texts.map((t) => deterministicVector(t, dimensions)),
        dimensions,
        pooling: "last-token",
        normalized: true,
      });
    },
    embedFull(req: EmbedRequest): Promise<EmbedFullResult> {
      return Promise.resolve({
        model,
        revision: "fake",
        items: req.texts.map((t) => ({
          dense: deterministicVector(t, dimensions),
          sparse: {},
          colbert: [],
        })),
      });
    },
    rerank(req: RerankRequest): Promise<RerankResult> {
      // Deterministic: longer documents score higher, stable tie-break on original index.
      const results = req.documents
        .map((d, index) => ({ index, relevanceScore: d.length }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
      return Promise.resolve({ results: req.topN ? results.slice(0, req.topN) : results, model });
    },
  };
}

export function fakeGenerationClient(): GenerationClient {
  const reply = (role: string, req: CompletionRequest): Promise<CompletionResult> =>
    Promise.resolve({
      text: `[${role}] ${req.messages.at(-1)?.content ?? ""}`,
      model: `fake/${role}`,
    });
  return {
    extract: (req) => reply("extract", req),
    synthesize: (req) => reply("synthesize", req),
    judge: (req) => reply("judge", req),
  };
}
