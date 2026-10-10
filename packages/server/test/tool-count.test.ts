// THE-306: pin the registered tool count so a tool added or removed without updating the documented
// headline fails CI. This assembles the full registry exactly as cli.ts does (server_health + M1–M8)
// against cheap stubs — registration only builds tool definitions (handlers close over deps), so no
// live backends are needed. Add or remove the tool's line in registered-tools.txt (sorted, one name
// per line) when the surface changes; the docs state no count, so nothing else needs bumping.

import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { JobQueue } from "../src/scheduler/job-queue";
import { buildRepresentationManifest } from "../src/search/representation";
import { RateLimiter } from "../src/throttle";
import { createHealthTool, createIndexStatusTool } from "../src/tools/admin/health";
import { createTaskStatusTool } from "../src/tools/admin/task-status";
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
// The count lives in its own module so tool-facade-domain-coverage.test.ts can share it rather
// than keeping a second literal in step by remembering (THE-548). See that file for the parsing
// contract check-version-coherence.mjs depends on.
import { REGISTERED_TOOL_COUNT, REGISTERED_TOOL_NAMES } from "./registered-tool-count";
import { makeTempDir, rmTemp } from "./tmp";

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

describe("THE-306 registered tool count", () => {
  const root = makeTempDir("obtc-count-");
  afterAll(() => rmTemp(root));

  it("registers exactly the documented tool surface", () => {
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
    // get_task_status is registered inline beside them (runtime/tool-wiring.ts wireHealthTools).
    registry.register(createTaskStatusTool({ queue: new JobQueue(db) }));
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
      representation: buildRepresentationManifest(embeddingProvider, {}),
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
      cacheDir: "",
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

    const actual = registry.list().map((t) => t.name);
    // Name the tools, not just a number: "expected 168, got 167" says nothing about which one.
    expect({
      inRegistryButNotListed: actual.filter((n) => !REGISTERED_TOOL_NAMES.includes(n)).sort(),
      listedButNotRegistered: REGISTERED_TOOL_NAMES.filter((n) => !actual.includes(n)),
    }).toEqual({ inRegistryButNotListed: [], listedButNotRegistered: [] });
    expect(actual.length).toBe(REGISTERED_TOOL_COUNT);
  });

  it("registered-tools.txt is well formed: sorted, unique, no blank or padded lines, non-trivial", () => {
    // Sorted so a new tool lands at its alphabetical position (two PRs only conflict when they add
    // neighbouring names); the floor stops a truncated or emptied file passing every other check.
    expect(REGISTERED_TOOL_NAMES.length).toBeGreaterThan(100);
    expect([...REGISTERED_TOOL_NAMES]).toEqual([...REGISTERED_TOOL_NAMES].sort());
    expect(new Set(REGISTERED_TOOL_NAMES).size).toBe(REGISTERED_TOOL_NAMES.length);
    for (const n of REGISTERED_TOOL_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
