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
import { createGatewayClient } from "../gateway/client";
import { buildModelTierProvider, buildModelTierReranker } from "../model";
import type { Reranker } from "../search/rerank";
import { openAiCompatibleProvider } from "./http-embeddings";
import { cohereCompatibleReranker } from "./http-rerank";
import { loadProviderModule } from "./module-loader";
import type {
  EmbeddingsConfigLike,
  EmbeddingsEntry,
  ProviderDescriptor,
  RerankerEntry,
  ResolveContext,
} from "./types";

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
    // "" — this entry does NOT consume the descriptor's top-level baseUrl at all;
    // buildModelTierProvider reads cfg.modelTier.{dense,full}.baseUrl instead. A non-empty
    // appendsPath here made the duplicate-segment guard fire on a baseUrl the adapter never reads,
    // then stay silently ignored even after the operator "fixed" it (deferred Minor from an
    // earlier task; see assertBaseUrlNotDuplicating's appendsPath === "" branch below).
    appendsPath: "",
    ownsPrefixing: true,
    build: (c, x) => buildModelTierProvider(c, { fetchFn: x.fetchFn }),
  },
  // The profile-gated escape hatch — see module-loader.ts's header comment. asyncOnly: true means
  // the sync `build` below is never actually called on a correctly-wired path; it exists only so
  // resolveEmbeddings' asyncOnly guard has something to refuse BEFORE reaching it (a documented
  // invariant, not a reachable code path).
  module: {
    appendsPath: "",
    asyncOnly: true,
    build: () => {
      throw err.invalidInput("module providers cannot be built synchronously", {
        hint: "this is a bug: resolveEmbeddings must refuse asyncOnly entries before calling build",
      });
    },
    buildAsync: (c, x) =>
      loadProviderModule<EmbeddingProvider>({
        modulePath: c.modulePath ?? "",
        configDir: x.configDir,
        securityProfile: x.securityProfile,
        exportName: "createEmbeddingProvider",
        slot: "embeddings",
        // THE-677: the module must not claim a built-in's identity. Computed from EMBEDDINGS minus
        // "module" itself — deriving it from the map means a provider added later is reserved
        // automatically, rather than from a hand-kept list that would silently go stale.
        reservedProviderNames: embeddingsProviderNames().filter((n) => n !== "module"),
      }),
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
  // An empty appendsPath means "this entry does not consume the descriptor's baseUrl at all"
  // (e.g. model-tier, which sources its endpoint(s) from a nested modelTier block) — there is
  // nothing for a top-level baseUrl to duplicate, so this guard has nothing to check.
  if (appendsPath === "") return;
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

/** Async resolution — the only path that can build an asyncOnly (module) entry. Boot-wiring only;
 *  CLI/eval entry points call the synchronous `resolveEmbeddings` above and get an actionable
 *  refusal instead of silently needing to become async themselves. */
export async function resolveEmbeddingsAsync(
  cfg: EmbeddingsConfigLike,
  ctx: ResolveContext = {},
): Promise<{ provider: EmbeddingProvider; entry: EmbeddingsEntry }> {
  const entry = embeddingsEntryOrThrow(cfg.provider);
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "embeddings");
  if (entry.buildAsync) return { provider: await entry.buildAsync(cfg, ctx), entry };
  return { provider: entry.build(cfg, ctx), entry };
}

const RERANKERS: Record<string, RerankerEntry> = {
  "cohere-compatible": {
    appendsPath: "/rerank",
    build: async (c, x) =>
      cohereCompatibleReranker({
        model: c.model,
        baseUrl: c.baseUrl,
        apiKey: resolveApiKey(c.provider, c.apiKey, c.apiKeyEnv),
        fetchFn: x.fetchFn,
        timeoutMs: c.timeoutMs,
      }),
  },
  // Reads the EMBEDDINGS config, not the reranker descriptor: buildModelTierReranker takes
  // ModelTierConfigLike, requiring `dimensions` and `modelTier` (model/factory.ts:87-94). Casting
  // the descriptor instead compiles and returns null forever.
  //
  // appendsPath "" — see assertBaseUrlNotDuplicating's comment: this entry never reads the
  // descriptor's baseUrl at all (nor model/apiKey/apiKeyEnv/timeoutMs), so it refuses to build if
  // an operator sets any of them — a loud boot error instead of a silently discarded field.
  "model-tier": {
    appendsPath: "",
    build: async (c, x) => {
      const ignored = (
        [
          ["model", c.model],
          ["baseUrl", c.baseUrl],
          ["apiKey", c.apiKey],
          ["apiKeyEnv", c.apiKeyEnv],
          ["timeoutMs", c.timeoutMs],
        ] as const
      )
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      if (ignored.length > 0) {
        throw err.invalidInput(
          `reranker.provider "model-tier" does not read ${ignored.map((k) => `reranker.${k}`).join(", ")}`,
          {
            provider: "model-tier",
            ignored,
            hint: "model-tier sources its model, endpoint and auth from embeddings.modelTier.full.* — remove these reranker fields (or configure embeddings.modelTier.full if you have not).",
          },
        );
      }
      return x.embeddings ? buildModelTierReranker(x.embeddings, { fetchFn: x.fetchFn }) : null;
    },
  },
  // Forwards the DECLARED config. GatewayClientOptions names them token / rerankModel / timeoutMs
  // (gateway/client.ts:62-74); dropping them silently falls back to env vars and model "rerank".
  gateway: {
    appendsPath: "/rerank",
    build: async (c, x) => {
      let gw: ReturnType<typeof createGatewayClient>;
      try {
        gw = createGatewayClient({
          baseUrl: c.baseUrl,
          token: resolveApiKey(c.provider, c.apiKey, c.apiKeyEnv),
          rerankModel: c.model,
          timeoutMs: c.timeoutMs,
          fetchFn: x.fetchFn,
        });
      } catch {
        return null; // no base URL configured -> graceful no-op, as today
      }
      return (q, docs, topN) =>
        gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results);
    },
  },
  // The profile-gated escape hatch — see module-loader.ts's header comment. Unlike the embeddings
  // entry above, RerankerEntry.build is already async, so there is no sync/asyncOnly split to make
  // here.
  module: {
    appendsPath: "",
    build: (c, x) =>
      loadProviderModule<Reranker>({
        modulePath: c.modulePath ?? "",
        configDir: x.configDir,
        securityProfile: x.securityProfile,
        exportName: "createReranker",
        slot: "reranker",
        // Inert for this slot today (a reranker module returns a bare function, so it declares no
        // identity), but passed for symmetry so the two entries cannot drift if that changes.
        reservedProviderNames: rerankerProviderNames().filter((n) => n !== "module"),
      }),
  },
};

/** Sorted so the unknown-name error message is stable and diffable. */
export function rerankerProviderNames(): string[] {
  return Object.keys(RERANKERS).sort();
}

export async function resolveReranker(
  cfg: ProviderDescriptor,
  ctx: ResolveContext = {},
): Promise<Reranker | null> {
  const entry = RERANKERS[cfg.provider];
  if (!entry) {
    throw err.invalidInput(`unknown reranker provider: ${cfg.provider}`, {
      provider: cfg.provider,
      hint: `set reranker.provider to one of: ${rerankerProviderNames().join(", ")}`,
    });
  }
  assertBaseUrlNotDuplicating(cfg.baseUrl, entry.appendsPath, "reranker");
  return entry.build(cfg, ctx);
}
