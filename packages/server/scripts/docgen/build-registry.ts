// docgen — build a ToolRegistry with the FULL tool surface registered, using stub dependencies
// (THE-471, tools extractor support). Registration only constructs the ToolDefinition objects
// (name / description / schemas / scopes / tags) — it never touches the DB or invokes a handler — so
// stub deps yield a registry whose describeCapability output is byte-accurate for docs.
//
// Mirrors the recipe proven by test/acl-extraction-coverage.test.ts (which registers the same
// surface to audit pathAcl coverage).

import { ToolRegistry } from "../../src/mcp/registry";
import { RateLimiter } from "../../src/throttle";
import { createHealthTool, createIndexStatusTool } from "../../src/tools/admin/health";
import { registerM1Tools } from "../../src/tools/m1";
import { registerM2Tools } from "../../src/tools/m2";
import { registerM3Tools } from "../../src/tools/m3";
import { registerM4Tools } from "../../src/tools/m4";
import { registerM5Tools } from "../../src/tools/m5";
import { registerM6Tools } from "../../src/tools/m6";
import { registerM7Tools } from "../../src/tools/m7";
import { registerM8Tools } from "../../src/tools/m8";
import { VaultRegistry } from "../../src/vault/registry";

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

/** A registry with every M1–M8 tool + the health tool registered against stub deps. */
export function buildFullRegistry(): ToolRegistry {
  const noop = (): void => {};
  const stub = undefined as never; // loosely-typed deps unused during registration
  const vaultRegistry = new VaultRegistry([{ id: "t", name: "t", path: process.cwd() }]);
  const rateLimiter = new RateLimiter(NO_THROTTLE as never);
  const embeddingProvider = {
    provider: "ollama",
    model: "nomic-embed-text",
    embed: async () => [],
  };
  const metadataIndex = { hasFts: false, ready: () => true };
  const bridge = () => ({ client: undefined, timeoutMs: 1000 });

  const registry = new ToolRegistry({ rateLimiter });
  registry.register(
    createHealthTool({
      version: "docgen",
      vaults: ["t"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      ftsEnabled: false,
    }),
  );
  // THE-491: get_index_status is registered directly in cli.ts alongside server_health, not
  // through a register*Tools domain function.
  registry.register(
    createIndexStatusTool({
      vecEnabled: false,
      ftsEnabled: false,
      getIndexHealth: () => ({ reconcile: "ok", reconcile_at: null, write_failures: 0 }),
      getLastChunksUpserted: () => null,
    }),
  );
  registerM1Tools(registry, {
    vaultRegistry,
    version: "docgen",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
    metadataIndex,
    reindex: noop,
    deindex: noop,
  });
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: embeddingProvider as never,
    dataviewBridge: bridge as never,
    regexTimeoutMs: 1000,
    metadataIndex,
  });
  registerM3Tools(registry, { vaultRegistry, reindex: noop, templaterBridge: bridge as never });
  registerM4Tools(registry, {
    reindex: noop,
    vaultRegistry,
    capabilities: stub,
    bridgeFor: () => undefined,
    timeouts: stub,
    commandPolicy: () => ({ enabled: false, allowlist: [] }),
    mode: () => "headless",
  });
  registerM5Tools(registry, {
    vaultRegistry,
    activeSessions: stub,
    reindex: noop,
    plur: stub,
    memoryFolder: () => "memory",
    traceFolder: () => "workspace",
  });
  registerM6Tools(registry, {
    vaultRegistry,
    rateLimiter,
    version: "docgen",
    startedAt: 0,
    authMode: "none",
    throttle: stub,
    observability: { otel: false, prometheus: false, morgiana: true },
    embeddingsProvider: "ollama",
    governorMaxResponseBytes: 1e6,
    capabilities: stub,
    registeredTools: () => registry.list().length,
    reindex: noop,
    deindex: noop,
  });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: embeddingProvider as never,
    reranker: stub,
    roles: stub,
  });
  registerM8Tools(registry, {});
  return registry;
}
