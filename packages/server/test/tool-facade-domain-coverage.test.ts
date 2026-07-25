// THE-577: the facade domain map is a hand-maintained parallel catalog of the tool surface
// (mcp/facade.ts DOMAINS), and nothing was enforcing that it tracked the registry. It fell 38 tools
// behind — 146 registered, 108 mapped — and stayed silent, because domainTools() sweeps anything
// unmapped into an "other" bucket. The surface stayed complete; discovery quality quietly rotted,
// with whole families (git, kanban, tables, snapshots, work-memory) collapsed under
// "Miscellaneous capabilities.".
//
// This gate closes that in BOTH directions, because each catches a different mistake:
//   forward  — a tool registered without a domain (the surface grew past the map: what happened).
//   backward — a domain member naming a tool that no longer exists (a rename or removal left a
//              stale entry). domainOfTool() cannot see this, which is why domainMapEntries() exists.
//
// Registry assembly mirrors tool-count.test.ts exactly: registration only builds tool definitions
// (handlers close over deps), so cheap stubs suffice and no live backend is needed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { domainMapEntries, domainOfTool } from "../src/mcp/facade";
import { ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";
import { createHealthTool, createIndexStatusTool } from "../src/tools/admin/health";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { registerM6Tools } from "../src/tools/m6";
import { registerM7Tools } from "../src/tools/m7";
import { registerM8Tools } from "../src/tools/m8";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

/** Mirrors tool-count.test.ts. Only a floor here, so the coverage assertions below cannot pass
 *  against an empty or partially-assembled registry. THE-306 owns keeping this in step with docs. */
const REGISTERED_TOOL_COUNT = 146;

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

describe("THE-577 facade domain-map coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "obtc-domain-cov-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("maps every registered tool to a domain, and names no tool that does not exist", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const vaultRegistry = new VaultRegistry([{ id: "t", name: "t", path: root }]);
    const rateLimiter = new RateLimiter(NO_THROTTLE as never);
    const registry = new ToolRegistry({ rateLimiter });
    const noop = () => {};
    // Stub backends: registration only builds tool definitions (handlers close over deps), so these
    // are never dereferenced here, which keeps the count pure and fast. `any` is permitted in test
    // files by the biome config.
    const embeddingProvider: any = {
      provider: "ollama",
      model: "nomic-embed-text",
      embed: async () => [],
    };
    const metadataIndex = { hasFts: false, ready: () => true };
    const bridge: any = () => ({ client: undefined, timeoutMs: 1000 });

    registry.register(
      createHealthTool({
        version: "test",
        vaults: ["t"],
        startedAt: 0,
        nativeLoaded: false,
        vecEnabled: false,
        ftsEnabled: false,
      }),
    );
    // THE-491: get_index_status is registered directly in cli.ts alongside server_health, not
    // through a register*Tools domain function — mirror that here so the count stays exact.
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
      version: "test",
      startedAt: 0,
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      metadataIndex,
      reindex: noop,
      deindex: noop,
    });
    registerM2Tools(registry, {
      vaultRegistry,
      embeddingProvider,
      dataviewBridge: bridge,
      regexTimeoutMs: 1000,
      metadataIndex,
    });
    registerM3Tools(registry, { vaultRegistry, reindex: noop, templaterBridge: bridge });
    registerM4Tools(registry, {
      reindex: noop,
      vaultRegistry,
      capabilities: (() => ({})) as never,
      bridgeFor: () => undefined,
      timeouts: (() => ({})) as never,
      commandPolicy: () => ({ enabled: false, allowlist: [] }),
      mode: () => "headless",
    });
    registerM5Tools(registry, {
      vaultRegistry,
      activeSessions: {} as never,
      reindex: noop,
      plur: {} as never,
      memoryFolder: () => "memory",
      traceFolder: () => "workspace",
    });
    registerM6Tools(registry, {
      vaultRegistry,
      rateLimiter,
      version: "test",
      startedAt: 0,
      authMode: "none",
      throttle: {} as never,
      observability: { otel: false, prometheus: false, morgiana: true },
      embeddingsProvider: "ollama",
      governorMaxResponseBytes: 1e6,
      capabilities: (() => ({})) as never,
      registeredTools: () => registry.list().length,
      reindex: noop,
      deindex: noop,
    });
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider,
      reranker: {} as never,
      roles: {} as never,
    });
    registerM8Tools(registry, {});

    const registered = registry.list().map((t) => t.name);
    // Sanity floor: an empty or truncated registry would make both assertions below pass
    // vacuously. See feedback on green checks that cover nothing.
    expect(registered.length).toBe(REGISTERED_TOOL_COUNT);

    // Forward: nothing may fall through to the "other" bucket.
    const unmapped = registered.filter((name) => domainOfTool(name) === undefined).sort();
    expect(
      unmapped,
      `${unmapped.length} registered tool(s) have no facade domain and would ship under "other". ` +
        `Add each to a DOMAINS[].members list in mcp/facade.ts: ${unmapped.join(", ")}`,
    ).toEqual([]);

    // Backward: the map may not name a tool that no longer exists.
    const live = new Set(registered);
    const stale = domainMapEntries()
      .filter(([name]) => !live.has(name))
      .map(([name, domain]) => `${name} (in "${domain}")`)
      .sort();
    expect(
      stale,
      `${stale.length} facade domain member(s) name a tool that is not registered — a rename or ` +
        `removal left the map stale: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
