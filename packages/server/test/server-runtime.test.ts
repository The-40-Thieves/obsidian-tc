// WP5.1 (issue 15): the boot-failure test the map's WP5 acceptance criterion requires — "the
// runtime is constructible in a test without parsing process arguments" is only true AFTER this
// slice's extraction, so the test lands with it. Two layers:
//
//  - `unwindReversed` (pure, spy-driven): pins the exact reverse-order contract. Reversing the
//    argument order or dropping an entry here is the bug class this function exists to catch — see
//    the task report for the literal red output from breaking it by hand during verification.
//  - `wireRuntimeCore` (real stores + governance + index resources, real temp cache dir, no argv): a
//    genuine construction failure (an unknown embeddings provider — createEmbeddingProvider throws
//    synchronously, no mocking needed) proves the production composition unwinds already-opened
//    resources (governance, then stores) in reverse order, and never touches indexResources' own
//    cleanup because indexResources itself never finished constructing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experientialMigrations } from "../src/cli/shared";
import { MetricsRecorder } from "../src/metrics/registry";
import {
  type RuntimeCoreDeps,
  unwindReversed,
  wireRuntimeCore,
} from "../src/runtime/server-runtime";
import { wireStores } from "../src/runtime/stores";

describe("unwindReversed — reverse-ownership-order cleanup", () => {
  it("closes already-built layers in REVERSE (most-recently-opened-first) order", async () => {
    const order: string[] = [];
    await unwindReversed([
      {
        name: "stores",
        close: () => {
          order.push("stores");
        },
      },
      {
        name: "governance",
        close: () => {
          order.push("governance");
        },
      },
    ]);
    // governance was opened AFTER stores, so it must close FIRST.
    expect(order).toEqual(["governance", "stores"]);
  });

  it("touches nothing beyond what was actually passed in — a layer that never finished opening", async () => {
    const order: string[] = [];
    // indexResources is absent: its own construction is what failed, so it never contributed a
    // cleanup entry. Only the two layers that DID finish (stores, governance) appear here.
    await unwindReversed([
      {
        name: "stores",
        close: () => {
          order.push("stores");
        },
      },
      {
        name: "governance",
        close: () => {
          order.push("governance");
        },
      },
    ]);
    expect(order).not.toContain("indexResources");
    expect(order).toHaveLength(2);
  });

  it("awaits an async close before moving to the next layer", async () => {
    const order: string[] = [];
    await unwindReversed([
      {
        name: "stores",
        close: async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("stores");
        },
      },
      {
        name: "governance",
        close: () => {
          order.push("governance");
        },
      },
    ]);
    expect(order).toEqual(["governance", "stores"]);
  });

  it("reports each cleanup through onCleanup in the same reverse order", async () => {
    const reported: string[] = [];
    await unwindReversed(
      [
        { name: "stores", close: () => {} },
        { name: "governance", close: () => {} },
      ],
      (name) => reported.push(name),
    );
    expect(reported).toEqual(["governance", "stores"]);
  });
});

describe("wireRuntimeCore — argv-free composition with unwind on failure", () => {
  const tmpDirs: string[] = [];
  const tmpCacheDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "otc-runtime-core-"));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const baseDeps = async (cacheDir: string): Promise<Omit<RuntimeCoreDeps, "embeddings">> => ({
    stores: await wireStores({
      cacheDir,
      version: "test",
      experiential: {
        logRetrievals: false,
        captureEpisodes: false,
        captureContent: false,
        activationRerank: false,
      },
      experientialMigrations,
    }),
    vaults: [{ id: "v1", path: cacheDir }],
    acl: { readOnly: false, defaultScopes: ["*"], rules: [] },
    defaultVaultId: undefined,
    elicitTtlSeconds: 300,
    throttle: { enabled: false, tiers: {} },
    maxResponseBytes: 1_000_000,
    idempotencyTtlSeconds: 86400,
    idempotencyReclaimSeconds: 60,
    toolVisibility: undefined,
    tracer: undefined,
    morgiana: { emit: () => {} },
    metrics: new MetricsRecorder(),
    onVecRebuild: () => {},
  });

  it("composes governance -> index resources on top of already-open stores, with no process.argv involved", async () => {
    const cacheDir = tmpCacheDir();
    const core = await wireRuntimeCore({
      ...(await baseDeps(cacheDir)),
      embeddings: {
        provider: "ollama",
        model: "test-model",
        dimensions: 8,
        batchSize: 8,
        concurrency: 1,
        maxBatchTokens: 1000,
        chunkContext: false,
      },
    });
    expect(core.governance.registry).toBeDefined();
    expect(core.indexResources.embeddingProvider.provider).toBe("ollama");
  });

  it("on a real construction failure, unwinds governance then stores, in that order — and never touches indexResources, which never finished opening", async () => {
    const cacheDir = tmpCacheDir();
    const cleanedUp: string[] = [];
    const deps = await baseDeps(cacheDir);
    await expect(
      wireRuntimeCore({
        ...deps,
        // createEmbeddingProvider throws synchronously on an unrecognized provider — a real
        // failure inside wireIndexResources, the last layer this function composes.
        embeddings: {
          provider: "definitely-not-a-real-provider",
          model: "x",
          dimensions: 8,
          batchSize: 8,
          concurrency: 1,
          maxBatchTokens: 1000,
          chunkContext: false,
        },
        onCleanup: (name) => cleanedUp.push(name),
      }),
    ).rejects.toThrow(/unknown embeddings provider/);
    // stores + governance opened successfully; indexResources never did. Reverse order: governance
    // (opened second) closes before stores (opened first); indexResources contributes nothing.
    expect(cleanedUp).toEqual(["governance", "stores"]);
  });
});
