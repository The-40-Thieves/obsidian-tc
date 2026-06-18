import { err } from "@obsidian-tc/shared";
import type { FetchFn } from "./http";
import { type EmbeddingProvider, resolveApiKey } from "./provider";
import { cohereProvider, ollamaProvider, openaiProvider, voyageProvider } from "./providers";
export interface EmbeddingsConfigLike {
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
}
export function createEmbeddingProvider(
  cfg: EmbeddingsConfigLike,
  opts: { fetchFn?: FetchFn; override?: EmbeddingProvider } = {},
): EmbeddingProvider {
  if (opts.override) return opts.override;
  const apiKey = resolveApiKey(cfg.provider, cfg.apiKey);
  const base = {
    model: cfg.model,
    dimensions: cfg.dimensions,
    baseUrl: cfg.baseUrl,
    apiKey,
    fetchFn: opts.fetchFn,
  };
  switch (cfg.provider) {
    case "ollama":
      return ollamaProvider(base);
    case "openai":
      return openaiProvider(base);
    case "voyage":
      return voyageProvider(base);
    case "cohere":
      return cohereProvider(base);
    default:
      throw err.invalidInput(`unknown embeddings provider: ${cfg.provider}`, {
        provider: cfg.provider,
      });
  }
}
export { fakeEmbeddingProvider, deterministicVector } from "./fake";
export type { EmbeddingProvider } from "./provider";
export { resolveApiKey } from "./provider";
