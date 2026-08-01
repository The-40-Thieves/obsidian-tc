// The single resolution point for both provider slots. Adding a model is adding a row to a map.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { EmbeddingProvider } from "../embeddings/provider";
import { resolveApiKey } from "../embeddings/provider";
import {
  bgeM3Provider,
  cohereProvider,
  ollamaProvider,
  openaiProvider,
  voyageProvider,
} from "../embeddings/providers";
import { buildModelTierProvider } from "../model";
import { openAiCompatibleProvider } from "./http-embeddings";
import type { EmbeddingsConfigLike, EmbeddingsEntry, ResolveContext } from "./types";

function adapterOpts(cfg: EmbeddingsConfigLike, ctx: ResolveContext) {
  return {
    model: cfg.model,
    dimensions: cfg.dimensions,
    baseUrl: cfg.baseUrl,
    apiKey: resolveApiKey(cfg.provider, cfg.apiKey, cfg.apiKeyEnv),
    fetchFn: ctx.fetchFn,
    timeoutMs: cfg.timeoutMs,
    truncate: cfg.truncate,
  };
}

// appendsPath values are the REAL suffix each adapter appends — verified against providers.ts.
// NOTE bge-m3 appends "/embeddings" (providers.ts:117), NOT "/encode". "/v1/encode" belongs to the
// separate model/bge.ts client used by model-tier. The first draft had this wrong, which would have
// made the duplicate-segment guard silently useless for bge-m3.
const EMBEDDINGS: Record<string, EmbeddingsEntry> = {
  ollama: { appendsPath: "/api/embed", build: (c, x) => ollamaProvider(adapterOpts(c, x)) },
  openai: { appendsPath: "/embeddings", build: (c, x) => openaiProvider(adapterOpts(c, x)) },
  voyage: { appendsPath: "/embeddings", build: (c, x) => voyageProvider(adapterOpts(c, x)) },
  cohere: { appendsPath: "/embed", build: (c, x) => cohereProvider(adapterOpts(c, x)) },
  "bge-m3": { appendsPath: "/embeddings", build: (c, x) => bgeM3Provider(adapterOpts(c, x)) },
  "openai-compatible": {
    appendsPath: "/embeddings",
    build: (c, x) => openAiCompatibleProvider(adapterOpts(c, x)),
  },
  "model-tier": {
    appendsPath: "/v1/embeddings",
    ownsPrefixing: true,
    build: (c, x) => buildModelTierProvider(c, { fetchFn: x.fetchFn }),
  },
};

/** Sorted so the unknown-name error message is stable and diffable. */
export function embeddingsProviderNames(): string[] {
  return Object.keys(EMBEDDINGS).sort();
}

/**
 * Refuse a baseUrl whose trailing segments already contain the path the entry appends.
 *
 * The adapters do NOT agree on what baseUrl means — openAiStyle appends "/embeddings" to a base
 * carrying "/v1", while model/tei.ts appends "/v1/embeddings" to a bare root. Refusing rather than
 * silently stripping is deliberate: stripping hides that the operator is on the wrong convention.
 */
export function assertBaseUrlNotDuplicating(
  baseUrl: string | undefined,
  appendsPath: string,
  slot: "embeddings" | "reranker",
): void {
  if (!baseUrl) return;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!trimmed.endsWith(appendsPath)) return;
  throw err.invalidInput(
    `${slot}.baseUrl already ends with "${appendsPath}", which this provider appends itself`,
    {
      baseUrl,
      hint: `the request URL would be "${trimmed}${appendsPath}". Set ${slot}.baseUrl to the prefix WITHOUT "${appendsPath}".`,
    },
  );
}

function embeddingsEntryOrThrow(name: string): EmbeddingsEntry {
  const entry = EMBEDDINGS[name];
  if (!entry) {
    throw err.invalidInput(`unknown embeddings provider: ${name}`, {
      provider: name,
      hint: `set embeddings.provider to one of: ${embeddingsProviderNames().join(", ")}`,
    });
  }
  return entry;
}

/** Synchronous resolution. Refuses asyncOnly entries (the module hatch) — see resolveEmbeddingsAsync. */
export function resolveEmbeddings(
  cfg: EmbeddingsConfigLike,
  ctx: ResolveContext = {},
): { provider: EmbeddingProvider; entry: EmbeddingsEntry } {
  const entry = embeddingsEntryOrThrow(cfg.provider);
  if (entry.asyncOnly) {
    throw err.invalidInput(
      `embeddings.provider "${cfg.provider}" cannot be used on this code path`,
      {
        provider: cfg.provider,
        hint: "a module provider is only loadable from the server's boot wiring, not from a CLI or eval entry point. Use a declarative provider (e.g. openai-compatible) for these commands.",
      },
    );
  }
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "embeddings");
  return { provider: entry.build(cfg, ctx), entry };
}
