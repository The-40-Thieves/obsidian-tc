import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { FetchFn } from "./http";
import { type EmbeddingProvider, type EmbedOptions, resolveApiKey } from "./provider";
import {
  bgeM3Provider,
  cohereProvider,
  ollamaProvider,
  openaiProvider,
  voyageProvider,
} from "./providers";
export interface EmbeddingsConfigLike {
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  /** GH #171: per-request embed timeout (ms). Undefined -> the postJson default. */
  timeoutMs?: number;
  /** THE-387: Matryoshka (MRL) truncation of a wider native output to `dimensions`. */
  truncate?: boolean;
  /** THE-405: asymmetric instruct prefixes (see config schema docs). Both default empty. */
  queryPrefix?: string;
  documentPrefix?: string;
}

/** THE-405: prefix seam applied at the factory so EVERY provider shares it — embeds marked
 *  input:"query" get `queryPrefix`, everything else (indexing is the default path) gets
 *  `documentPrefix`. Off (identity) when both are empty. */
function withPrefixes(p: EmbeddingProvider, qp: string, dp: string): EmbeddingProvider {
  const affix = (texts: string[], o?: EmbedOptions): string[] => {
    const pre = o?.input === "query" ? qp : dp;
    return pre === "" ? texts : texts.map((t) => pre + t);
  };
  const wrapped: EmbeddingProvider = {
    id: p.id,
    provider: p.provider,
    model: p.model,
    dimensions: p.dimensions,
    embed: (texts, o) => p.embed(affix(texts, o), o),
  };
  const full = p.embedFull?.bind(p);
  if (full) wrapped.embedFull = (texts, o) => full(affix(texts, o), o);
  return wrapped;
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
    truncate: cfg.truncate,
  };
  const provider = (() => {
    switch (cfg.provider) {
      case "ollama":
        return ollamaProvider(base);
      case "openai":
        return openaiProvider(base);
      case "voyage":
        return voyageProvider(base);
      case "cohere":
        return cohereProvider(base);
      case "bge-m3":
        return bgeM3Provider(base);
      default:
        throw err.invalidInput(`unknown embeddings provider: ${cfg.provider}`, {
          provider: cfg.provider,
        });
    }
  })();
  const qp = cfg.queryPrefix ?? "";
  const dp = cfg.documentPrefix ?? "";
  return qp === "" && dp === "" ? provider : withPrefixes(provider, qp, dp);
}
export { deterministicVector, fakeEmbeddingProvider } from "./fake";
export type { EmbeddingProvider } from "./provider";
export { resolveApiKey } from "./provider";
