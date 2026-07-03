// Embedding provider abstraction (G2.2 component 8).
import { err } from "@the-40-thieves/obsidian-tc-shared";
/** THE-308: how to encode the input. Asymmetric models (e.g. Cohere v3) embed a search query
 *  differently from a corpus document; "document" is the default (indexing is the common path). */
export interface EmbedOptions {
  input?: "query" | "document";
}
export interface EmbeddingProvider {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}
const ENV_KEY: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  cohere: "COHERE_API_KEY",
};
export function resolveApiKey(provider: string, configKey?: string): string | undefined {
  if (configKey && configKey.length > 0) return configKey;
  const name = ENV_KEY[provider];
  return name ? process.env[name] : undefined;
}
export function assertVectors(vectors: number[][], expected: number, count: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count)
    throw err.embeddingProviderError("wrong number of vectors", { expected_count: count });
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== expected)
      throw err.embeddingProviderError("unexpected dimension", { expected_dim: expected });
    if (!v.every((x) => Number.isFinite(x)))
      throw err.embeddingProviderError("non-finite embedding component", {
        expected_dim: expected,
      });
  }
  return vectors;
}
