import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { CapabilityCache } from "../bridge";
import type { ToolRegistry } from "../mcp/registry";
import type { RateLimiter } from "../throttle";
import type { M6Deps, SandboxRerunFn } from "../tools/m6";
import type { ResponseFormat } from "../tools/response-format";
import type { VaultRegistry } from "../vault/registry";

/** The slice of `DomainToolsDeps` (tool-wiring.ts) that M6's deps are built from. */
export interface M6WiringInputs {
  vaultRegistry: VaultRegistry;
  rateLimiter: RateLimiter;
  version: string;
  startedAt: number;
  capabilities: CapabilityCache;
  sandboxRerun: SandboxRerunFn;
}

// M6 bulk + URI + admin: one shared RateLimiter (G2.4 tiers from config) is consumed by the
// bulk tools and snapshotted by get_metrics; the admin tools read non-secret config/ACL/metrics.
// Extracted from tool-wiring.ts (biome's 700-line cap); `registry` is only read lazily, by the
// closures below, because M6 is registered onto it after this object is built.
export function buildM6Deps(
  config: ServerConfig,
  deps: M6WiringInputs,
  registry: ToolRegistry,
  responseFormat: ResponseFormat | undefined,
): M6Deps {
  return {
    vaultRegistry: deps.vaultRegistry,
    responseFormat,
    rateLimiter: deps.rateLimiter,
    version: deps.version,
    startedAt: deps.startedAt,
    authMode: config.auth.mode,
    throttle: config.throttle,
    observability: {
      otel: !!config.observability.otel.endpoint,
      prometheus: config.observability.prometheus.enabled,
      morgiana: config.observability.morgiana.spool || !!config.observability.morgiana.httpEndpoint,
    },
    embeddingsProvider: config.embeddings.provider,
    governorMaxResponseBytes: config.governor.maxResponseBytes,
    retrieval: {
      ...(config.retrieval.rrfK !== undefined ? { rrfK: config.retrieval.rrfK } : {}),
      ...(config.retrieval.densify.knnMinSim !== undefined
        ? { knnMinSim: config.retrieval.densify.knnMinSim }
        : {}),
      derivedDefaults: config.retrieval.derivedDefaults,
    },
    capabilities: (vaultId) => deps.capabilities.get(vaultId),
    registeredTools: () => registry.list().length,
    // THE-645 item 2. Lazy for the same reason registeredTools is: M6 is registered onto this
    // registry, so the surface is incomplete at the moment this object is built.
    toolSurface: () => ({ config: registry.visibilityConfig(), tools: registry.list() }),
    rerun: deps.sandboxRerun,
    cacheDir: config.cacheDir,
  };
}
