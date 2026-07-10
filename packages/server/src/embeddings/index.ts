import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { FetchFn } from "./http";
import { type EmbeddingProvider, resolveApiKey } from "./provider";
import { cohereProvider, ollamaProvider, openaiProvider, voyageProvider } from "./providers";
export interface EmbeddingsConfigLike {
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  /** GH #171: per-request embed timeout (ms). Undefined -> the postJson default. */
  timeoutMs?: number;
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
    timeoutMs: cfg.timeoutMs,
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
export { deterministicVector, fakeEmbeddingProvider } from "./fake";
export type { EmbeddingProvider } from "./provider";
export { resolveApiKey } from "./provider";
