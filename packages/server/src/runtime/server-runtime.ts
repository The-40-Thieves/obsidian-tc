// WP5.1 (issue 15): the target `ServerRuntime` shape from the refactor map
// (docs/plans/2026-07-30-codebase-refactor-map.md, WP5) and the composition entry this slice
// delivers toward it.
//
// `ServerRuntime` is declared now so WP5.2 (tool/plane/scheduler/transport wiring + shutdown) has a
// stable target to implement against rather than inventing the shape mid-extraction. It is NOT fully
// implemented by this slice: `start`/`close` need the transports and the ordered shutdown sequence,
// which are still in cli.ts by design (see cli.ts's header comment). What this slice CAN deliver —
// and does — is `wireRuntimeCore`: governance -> index resources, composed in one argv-free call
// with construction-order-reversed cleanup on failure, taking already-open stores (runtime/stores.ts)
// as an input rather than constructing them itself.
//
// Why stores is a PARAMETER, not built here: `ToolRegistry` (governance) needs the OTEL tracer and
// the Prometheus/MORGIANA observability module's `metrics`/`morgiana`, both of which the observability
// module (runtime/observability.ts, extracted in a prior slice) derives from `stores.db`. Real boot
// therefore has cli.ts's own OTEL-init + `createObservability` call sitting textually BETWEEN stores
// and governance — a gap this slice does not own (observability.ts already exists; the otel.init
// call and the `let indexCoordinatorRef`/`schedulerRef` lazy-ref plumbing it depends on are WP5.2's
// concern). Folding that gap in here would mean either reordering real boot steps (forbidden) or
// accepting an arbitrary "give me your deps" callback, which starts to look like the service-locator
// this file is told not to build. Taking `stores` as an input and folding its cleanup into THIS
// call's unwind stack gets the same reverse-order guarantee without either problem: a failure in
// governance or index resources still closes stores, in the right order, and the boot-failure test
// below exercises exactly that.
import type { Tracer } from "@opentelemetry/api";
import type { VaultConfigInput } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { EmbeddingsConfigLike } from "../embeddings";
import type { ToolRegistry } from "../mcp/registry";
import type { RegistryOptions } from "../mcp/registry/types";
import type { MetricsRecorder } from "../metrics/registry";
import type { MorgianaEmitter } from "../morgiana/emitter";
import type { VecRebuildEvent } from "../search/vec";
import type { ThrottleTiers } from "../throttle";
import { type Governance, wireGovernance } from "./governance";
import { type IndexHealthState, type IndexResources, wireIndexResources } from "./indexing-wiring";
import type { Stores } from "./stores";

/** The map's target shape (WP5). `registry` is the one thing every caller of a fully-composed
 *  runtime needs; `start`/`close` are the two lifecycle verbs — nothing else is public runtime
 *  state. WP5.2 implements this; this slice only declares it. */
export interface ServerRuntime {
  registry: ToolRegistry;
  start(): Promise<void>;
  close(reason: string): Promise<void>;
}

/** THE-466 slice 2's established idiom (see cli.ts's original header comment): a boot resource read
 *  through a closure before the `const`/`let` that holds it has executed is a bug if that closure is
 *  ever CALLED early, and correct — by construction, never called before boot finishes — otherwise. A
 *  thrown Error (never a non-null assertion, forbidden by lint) documents the invariant instead of
 *  silently returning undefined. Moved here from cli.ts because `wireRuntimeCore` below now needs
 *  the same pattern for `indexHealth` (constructed one step after the registry that closes over it);
 *  cli.ts still uses it for `indexCoordinatorRef`/`schedulerRef` (WP5.2) and imports it from here. */
export function requireBoot<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} read before boot completed`);
  return value;
}

interface OwnedLayer {
  name: "stores" | "governance" | "indexResources";
  close(): void | Promise<void>;
}

/**
 * Run each already-built layer's cleanup in REVERSE (most-recently-opened-first) order — the
 * resource-acquisition-is-cleanup pattern `wireRuntimeCore` uses when a later wiring step throws.
 * Exported and independently testable: a layer that was never built never contributed a cleanup, so
 * it can never be touched here, and reversing (or dropping) an entry in `layers` is exactly the bug
 * class this function exists to make loud — see server-runtime.test.ts.
 */
export async function unwindReversed(
  layers: readonly OwnedLayer[],
  onCleanup?: (name: OwnedLayer["name"]) => void,
): Promise<void> {
  for (const layer of [...layers].reverse()) {
    await layer.close();
    onCleanup?.(layer.name);
  }
}

export interface RuntimeCoreDeps {
  /** Already-open stores. Ownership of its cleanup transfers to this call for its duration — see
   *  this file's header comment for why stores is built outside and handed in rather than
   *  constructed here. */
  stores: Stores;
  // governance
  vaults: VaultConfigInput[];
  /** config.acl — root ACL, inherited by any vault without its own. */
  acl: ConstructorParameters<typeof FolderAcl>[0];
  /** OBSIDIAN_TC_DEFAULT_VAULT */
  defaultVaultId: string | undefined;
  elicitTtlSeconds: number;
  throttle: { enabled: boolean; tiers: ThrottleTiers };
  maxResponseBytes: number;
  idempotencyTtlSeconds: number;
  idempotencyReclaimSeconds: number;
  toolVisibility: RegistryOptions["toolVisibility"];
  tracer: Tracer | undefined;
  morgiana: Pick<MorgianaEmitter, "emit">;
  // shared
  metrics: MetricsRecorder;
  // index resources
  embeddings: EmbeddingsConfigLike & {
    batchSize: number;
    concurrency: number;
    maxBatchTokens: number;
    chunkContext: boolean;
  };
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** Test-only observability: fires with each layer's name, in the order its cleanup actually ran.
   *  Only invoked when a later step throws during construction — never on the happy path, and never
   *  by production callers, which omit it. */
  onCleanup?: (name: OwnedLayer["name"]) => void;
}

export interface RuntimeCore {
  governance: Governance;
  indexResources: IndexResources;
}

/**
 * Compose governance -> index resources on top of already-open stores, with no process-argument
 * parsing — the map's acceptance criterion for WP5 ("the runtime is constructible in a test without
 * parsing process arguments"), scoped to what this slice actually extracted. If governance or index
 * resources throws during construction, every already-built layer's cleanup — INCLUDING the stores
 * handed in — runs in reverse order (via `unwindReversed`) before the error propagates, so a partial
 * boot never leaks an open db handle.
 */
export async function wireRuntimeCore(deps: RuntimeCoreDeps): Promise<RuntimeCore> {
  const built: OwnedLayer[] = [{ name: "stores", close: deps.stores.close }];
  // THE-457 (governance's onAuditFailure): indexHealth is constructed one step AFTER the registry
  // that closes over it — same forward-reference shape as cli.ts's indexCoordinatorRef/schedulerRef.
  let indexHealthRef: IndexHealthState | undefined;
  try {
    const governance = wireGovernance({
      db: deps.stores.db,
      vaults: deps.vaults,
      acl: deps.acl,
      defaultVaultId: deps.defaultVaultId,
      elicitTtlSeconds: deps.elicitTtlSeconds,
      throttle: deps.throttle,
      maxResponseBytes: deps.maxResponseBytes,
      idempotencyTtlSeconds: deps.idempotencyTtlSeconds,
      idempotencyReclaimSeconds: deps.idempotencyReclaimSeconds,
      toolVisibility: deps.toolVisibility,
      metrics: deps.metrics,
      tracer: deps.tracer,
      morgiana: deps.morgiana,
      ...(deps.stores.episodeCapture ? { onEpisode: deps.stores.episodeCapture } : {}),
      getAuditWriteFailureCounter: () => requireBoot(indexHealthRef, "indexHealth"),
    });
    built.push({ name: "governance", close: governance.close });

    const indexResources = wireIndexResources({
      db: deps.stores.db,
      metrics: deps.metrics,
      embeddings: deps.embeddings,
      onVecRebuild: deps.onVecRebuild,
    });
    indexHealthRef = indexResources.indexHealth;
    built.push({ name: "indexResources", close: () => {} });

    return { governance, indexResources };
  } catch (err) {
    await unwindReversed(built, deps.onCleanup);
    throw err;
  }
}
