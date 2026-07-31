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
import { configFromVaultPath } from "../src/cli/args";
import { experientialMigrations } from "../src/cli/shared";
import { MetricsRecorder } from "../src/metrics/registry";
import {
  buildServerRuntime,
  type RuntimeCoreDeps,
  unwindReversed,
  wireRuntimeCore,
} from "../src/runtime/server-runtime";
import { type Stores, wireStores } from "../src/runtime/stores";

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

  // Every Stores this describe opens, so afterEach can close them BEFORE removing the temp dir.
  // Windows refuses to delete a file that still has an open handle, and the happy-path test
  // SUCCEEDS — so no unwind runs, so its sqlite handles are still open at cleanup and rmSync fails
  // with EPERM (`force: true` suppresses ENOENT, never EPERM). The unwind tests passed on Windows
  // precisely because the failure under test closed their stores for them. POSIX unlinks an open
  // file happily, which is why this only ever showed up on windows-latest.
  const openStores: Stores[] = [];
  const track = (s: Stores): Stores => {
    openStores.push(s);
    return s;
  };

  afterEach(() => {
    for (const s of openStores.splice(0)) {
      try {
        s.close();
      } catch {
        // Already closed by an unwind under test — close is idempotent by contract, and a
        // double-close must not mask the assertion failure that actually matters.
      }
      try {
        // `Stores.close()` deliberately closes `db` only, matching pre-extraction shutdown. With
        // every experiential gate off (this suite's config) wireStores has already released
        // experientialDb at line ~82, so this is a no-op today — but a future test that enables one
        // of those gates would hold a second handle and reintroduce the same EPERM on Windows.
        s.experientialDb.close?.();
      } catch {
        // Already released by wireStores, or by the close() above.
      }
    }
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const baseDeps = async (cacheDir: string): Promise<Omit<RuntimeCoreDeps, "embeddings">> => ({
    stores: track(
      await wireStores({
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
    ),
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

  // otel-unwind-on-core-failure: WP5.1's unwind above only knew about its fixed three layers
  // (stores/governance/indexResources) — `otel` sits textually between `stores` and this call in
  // real boot (buildServerRuntime), so a throw here never reached it. `RuntimeCoreDeps.otel` is now
  // an optional fourth layer, folded into the SAME `built`/`unwindReversed` mechanism at its real
  // open position (right after stores, before governance) — reused, not duplicated.
  it("also unwinds otel — between governance and stores — when otel is supplied and construction fails", async () => {
    const cacheDir = tmpCacheDir();
    const cleanedUp: string[] = [];
    const deps = await baseDeps(cacheDir);
    let otelShutdownCalled = false;
    await expect(
      wireRuntimeCore({
        ...deps,
        otel: {
          shutdown: async () => {
            otelShutdownCalled = true;
          },
        },
        // Same real, synchronous failure the previous test uses (createEmbeddingProvider throws on
        // an unrecognized provider) — this test is about otel's POSITION in the unwind, not a new
        // failure mode.
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
    expect(otelShutdownCalled).toBe(true);
    // otel opened AFTER stores and BEFORE governance in real boot, so reverse-ownership order closes
    // it AFTER governance (opened later) and BEFORE stores (opened first) — the same relationship
    // the file header describes for otel vs. wireRuntimeCore's own layers.
    expect(cleanedUp).toEqual(["governance", "otel", "stores"]);
  });

  it("swallows a throwing otel.shutdown() during unwind — the real construction error still propagates, not the shutdown error", async () => {
    const cacheDir = tmpCacheDir();
    const deps = await baseDeps(cacheDir);
    await expect(
      wireRuntimeCore({
        ...deps,
        otel: {
          shutdown: async () => {
            throw new Error("otel shutdown boom — must never surface");
          },
        },
        embeddings: {
          provider: "definitely-not-a-real-provider",
          model: "x",
          dimensions: 8,
          batchSize: 8,
          concurrency: 1,
          maxBatchTokens: 1000,
          chunkContext: false,
        },
      }),
    ).rejects.toThrow(/unknown embeddings provider/);
  });
});

// WP5.2 (issue 16): extends the boot-failure coverage above to the layers this slice adds on top
// of `wireRuntimeCore` — the vault watcher and the transports. `buildServerRuntime` wraps
// everything it builds AFTER `wireRuntimeCore` in its OWN try/catch, pushing each new layer onto
// `postCoreLayers` only once it has actually finished constructing, and unwinding that stack (plus
// the stores/governance handed off by `wireRuntimeCore`) in reverse order on a later throw — see
// server-runtime.ts's `buildServerRuntime`.
describe("buildServerRuntime — post-core unwind on a real late boot failure", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // BEST-EFFORT, and deliberately so. Windows refuses to unlink a file that still has an open
        // handle (`force: true` suppresses ENOENT, never EPERM), and these cases exercise a FAILED
        // boot: the post-core unwind closes the layers it owns — watcher, governance, stores — but a
        // failed boot intentionally does not chase every handle, because the real process is about
        // to exit and the OS reclaims them. `stores.close()` closes `db` only (matching production
        // shutdown), so experientialDb can still be open here depending on the config's experiential
        // gates, and the test has no handle on it — buildServerRuntime owns those internals.
        //
        // Swallowing this is safe because the assertion under test is the unwind ORDER, which has
        // already run and been asserted by the time afterEach fires. A leftover temp dir in the
        // runner's TMP is inert. `metrics-endpoint` already carries the same concession ("still
        // returns its metrics when temp-dir removal throws EBUSY").
      }
    }
  });

  it("closes the watcher, then governance, then stores — in reverse order — when a step AFTER wireIndexCoordinator throws", async () => {
    const vaultDir = tmpDir("otc-runtime-vault-");
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-runtime-cache-");
    // metrics/endpoint.ts's startMetricsEndpoint throws SYNCHRONOUSLY (before any socket is ever
    // opened) on a non-loopback bind under auth.mode "none" (G2.2 commitment 8) — a real
    // production safety check, not a test-only injection, and one with no hang risk (unlike an
    // actual port conflict, which @hono/node-server's Node path never rejects on — see
    // transports/serve.ts). This fires inside wireTransports, deep in buildServerRuntime's
    // sequence: AFTER the watcher (wireIndexCoordinator) and M1-M8 registration have already
    // succeeded, and BEFORE wireTransports itself finishes (so "transports" is never pushed).
    config.observability.prometheus.enabled = true;
    config.observability.prometheus.bind = "0.0.0.0";
    config.transports.http.enabled = false; // avoid the real HTTP bind entirely

    const cleanedUp: string[] = [];
    await expect(
      buildServerRuntime(config, undefined, (name) => cleanedUp.push(name)),
    ).rejects.toThrow(/refuses a non-localhost bind/);
    // watcher (opened third, after stores+governance) closes first; then governance; then stores.
    // "transports" never appears — wireTransports itself is what threw, so it never finished.
    expect(cleanedUp).toEqual(["watcher", "governance", "stores"]);
  });
});

// otel-unwind-on-core-failure: proves the PRODUCTION wiring, not just the isolated `wireRuntimeCore`
// unit tests above — `buildServerRuntime` opens `otel` between `stores` and its call into
// `wireRuntimeCore`, and a throw INSIDE wireRuntimeCore is a failure window `postCoreLayers` never
// sees (that array is only built AFTER wireRuntimeCore returns — see the describe block above, whose
// scenario forces a LATER failure instead). Before this fix, `buildServerRuntime` never passed
// `otel` (or `onCleanup`) into its `wireRuntimeCore` call at all, so this exact scenario leaked the
// OTEL SDK with no unwind covering it whatsoever.
describe("buildServerRuntime — otel unwind when wireRuntimeCore itself throws", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // Same best-effort concession as the sibling describe block above: this exercises a FAILED
        // boot, and the unwind order (the thing under test) has already run and been asserted by the
        // time this fires.
      }
    }
  });

  it("closes otel between governance and stores when governance/index-resources construction fails inside wireRuntimeCore", async () => {
    const vaultDir = tmpDir("otc-runtime-otel-vault-");
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-runtime-otel-cache-");
    // Same real, synchronous failure the wireRuntimeCore-level tests above use:
    // createEmbeddingProvider throws on an unrecognized provider, inside wireIndexResources — the
    // LAST thing wireRuntimeCore composes, so governance (and otel, opened before wireRuntimeCore is
    // even called) have already opened by the time it fires.
    config.embeddings.provider =
      "definitely-not-a-real-provider" as unknown as typeof config.embeddings.provider;

    const cleanedUp: string[] = [];
    await expect(
      buildServerRuntime(config, undefined, (name) => cleanedUp.push(name)),
    ).rejects.toThrow(/unknown embeddings provider/);
    // Real boot's open order is stores -> otel -> governance; indexResources never finishes. Reverse
    // order: governance (opened last) closes first, then otel (opened between stores and
    // governance), then stores. "watcher"/"transports" never appear — buildServerRuntime's OWN
    // post-core construction (where those come from) never starts, because wireRuntimeCore itself is
    // what threw.
    expect(cleanedUp).toEqual(["governance", "otel", "stores"]);
  });
});
