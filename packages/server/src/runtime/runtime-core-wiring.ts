// `wireRuntimeCore` — split out of server-runtime.ts (same reason boot-helpers.ts and
// runtime-core-types.ts exist, see their own headers) to keep that file under biome's 700-line
// noExcessiveLinesPerFile cap. Re-exported from server-runtime.ts so every existing import path
// (including `wireRuntimeCore`'s own test suite) keeps working.
import { DEFAULT_BUSY_TIMEOUT_MS } from "../db/pragmas";
import { createRateLimitBackend, DEFAULT_REDIS_REF } from "../ratelimit/create";
import { type OwnedLayer, requireBoot, unwindReversed } from "./boot-helpers";
import { wireGovernance } from "./governance";
import { type IndexHealthState, wireIndexResources } from "./indexing-wiring";
import type { RuntimeCore, RuntimeCoreDeps } from "./runtime-core-types";

/**
 * Composes governance -> index resources on top of already-open stores, with no process-argument
 * parsing (constructible in a test without parsing argv). If governance or index resources throws
 * during construction, every already-built layer's cleanup — INCLUDING the stores (and, when
 * supplied, otel) handed in — runs in reverse order via `unwindReversed` before the error
 * propagates, so a partial boot never leaks an open db handle or a live OTEL exporter.
 */
export async function wireRuntimeCore(deps: RuntimeCoreDeps): Promise<RuntimeCore> {
  const built: OwnedLayer[] = [{ name: "stores", close: deps.stores.close }];
  // otel opens right after stores in real boot, so its cleanup slots in here too. `.catch` swallows
  // a shutdown() rejection so it can never replace the real error `unwindReversed` is propagating.
  if (deps.otel) {
    const otel = deps.otel;
    built.push({ name: "otel", close: () => otel.shutdown().catch(() => {}) });
  }
  // (governance's onAuditFailure): indexHealth is constructed one step AFTER the registry
  // that closes over it — same forward-reference shape as cli.ts's indexCoordinatorRef/schedulerRef.
  let indexHealthRef: IndexHealthState | undefined;
  try {
    // The shared bucket store (sqlite / redis) is opened here, before governance, so a bad
    // reference (no Redis URL, a missing @redis/client, an unwritable cacheDir) refuses boot loudly
    // rather than surfacing as a runtime "outage". The default memory backend loads nothing.
    const rateLimitBackend = await createRateLimitBackend(
      {
        backend: deps.throttle.backend ?? "memory",
        redis: deps.throttle.redis ?? DEFAULT_REDIS_REF,
      },
      { cacheDir: deps.cacheDir, busyTimeoutMs: deps.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS },
    );
    let governance: ReturnType<typeof wireGovernance>;
    try {
      governance = wireGovernance({
        db: deps.stores.db,
        cacheDir: deps.cacheDir,
        ...(deps.traceContent !== undefined ? { traceContent: deps.traceContent } : {}),
        vaults: deps.vaults,
        acl: deps.acl,
        defaultVaultId: deps.defaultVaultId,
        elicitTtlSeconds: deps.elicitTtlSeconds,
        throttle: deps.throttle,
        rateLimitBackend,
        maxResponseBytes: deps.maxResponseBytes,
        idempotencyTtlSeconds: deps.idempotencyTtlSeconds,
        idempotencyReclaimSeconds: deps.idempotencyReclaimSeconds,
        toolVisibility: deps.toolVisibility,
        metrics: deps.metrics,
        tracer: deps.tracer,
        otelDetail: deps.otelDetail,
        morgiana: deps.morgiana,
        ...(deps.stores.episodeCapture ? { onEpisode: deps.stores.episodeCapture } : {}),
        getAuditWriteFailureCounter: () => requireBoot(indexHealthRef, "indexHealth"),
      });
    } catch (e) {
      await rateLimitBackend.close().catch(() => {});
      throw e;
    }
    built.push({ name: "governance", close: governance.close });

    const indexResources = await wireIndexResources({
      db: deps.stores.db,
      metrics: deps.metrics,
      embeddings: deps.embeddings,
      // GH #995 fix round 2 (item B): the SAME `deps.vaults` governance is built from — sticky
      // resolution must scope its cache-db query to the exact vault ids this boot registers.
      vaults: deps.vaults,
      onVecRebuild: deps.onVecRebuild,
      configDir: deps.configDir,
      securityProfile: deps.securityProfile,
      cacheDir: deps.cacheDir,
      ...(deps.excludeFilter !== undefined ? { excludeFilter: deps.excludeFilter } : {}),
    });
    indexHealthRef = indexResources.indexHealth;
    built.push({ name: "indexResources", close: () => {} });

    return { governance, indexResources };
  } catch (e) {
    await unwindReversed(built, deps.onCleanup);
    throw e;
  }
}
