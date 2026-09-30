// `RuntimeCoreDeps`/`RuntimeCore` — the input/output contract for server-runtime.ts's
// `wireRuntimeCore`. Split into their own module (same reason boot-helpers.ts exists, see that
// file's header) to keep server-runtime.ts under biome's 700-line noExcessiveLinesPerFile cap:
// this pair is a pure type contract with no wiring logic of its own, so lifting it is a clean
// split rather than the circular-import trap CLAUDE.md warns a naive one creates. Re-exported
// from server-runtime.ts so every existing import path keeps working.
import type { Tracer } from "@opentelemetry/api";
import type { VaultConfigInput } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { EmbeddingsConfigLike } from "../embeddings";
import type { RegistryOptions } from "../mcp/registry/types";
import type { MetricsRecorder } from "../metrics/registry";
import type { MorgianaEmitter } from "../morgiana/emitter";
import type { OtelDetail } from "../otel/dispatch-spans";
import type { OtelHandle } from "../otel/tracing";
import type { EgressFilter } from "../plane/egress-filter";
import type { RateLimitFailurePolicy } from "../ratelimit/backend";
import type { ThrottleBackendConfig } from "../ratelimit/create";
import type { VecRebuildEvent } from "../search/vec";
import type { ThrottleTiers } from "../throttle";
import type { OwnedLayer } from "./boot-helpers";
import type { Governance } from "./governance";
import type { IndexResources } from "./indexing-wiring";
import type { Stores } from "./stores";

export interface RuntimeCoreDeps {
  /** Already-open stores. Ownership of its cleanup transfers to this call for its duration — see
   *  server-runtime.ts's header comment for why stores is built outside and handed in rather than
   *  here. */
  stores: Stores;
  /** Trace storage root (config.cacheDir) — governance's sessionTracer resolves a cache-store
   *  session's trace against it instead of the vault root. */
  cacheDir: string;
  /** `sessions.traceContent` — capture dispatch arguments onto the trace. */
  traceContent?: boolean;
  /** Already-initialized OTEL handle, opened between `stores` and this call in real boot. Optional
   *  (unit tests of `wireRuntimeCore` omit it). When present, `shutdown()` runs best-effort on
   *  unwind — its rejection is swallowed so it can never replace the real construction error that
   *  is propagating. See docs/design/server-runtime.md. */
  otel?: Pick<OtelHandle, "shutdown">;
  // governance
  vaults: VaultConfigInput[];
  /** config.acl — root ACL, inherited by any vault without its own. */
  acl: ConstructorParameters<typeof FolderAcl>[0];
  /** OBSIDIAN_TC_DEFAULT_VAULT */
  defaultVaultId: string | undefined;
  elicitTtlSeconds: number;
  throttle: {
    enabled: boolean;
    tiers: ThrottleTiers;
    /** Bucket store; absent means the process-local default (see ../ratelimit). */
    backend?: ThrottleBackendConfig["backend"];
    redis?: ThrottleBackendConfig["redis"];
    failurePolicy?: RateLimitFailurePolicy;
  };
  /** config.db.busyTimeoutMs — bounds a contended shared-sqlite bucket update. */
  busyTimeoutMs?: number;
  maxResponseBytes: number;
  idempotencyTtlSeconds: number;
  idempotencyReclaimSeconds: number;
  toolVisibility: RegistryOptions["toolVisibility"];
  tracer: Tracer | undefined;
  /** config.observability.otel.detail */
  otelDetail?: OtelDetail;
  morgiana: Pick<MorgianaEmitter, "emit">;
  // shared
  metrics: MetricsRecorder;
  // index resources
  embeddings: EmbeddingsConfigLike & {
    batchSize: number;
    concurrency: number;
    maxBatchTokens: number;
    chunkContext: boolean;
    onProviderChange: "keep" | "switch";
  };
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** `dirname(configPath)` — the trust root for embeddings.modulePath (the module hatch). Undefined
   *  only when `configPath` itself is absent, NOT in zero-config vault-path mode. See
   *  `ResolveContext.configDir`'s doc comment (providers/types.ts) and docs/design/server-runtime.md. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
  /** config.egress.excludePaths, compiled. Threaded into wireIndexResources ->
   *  createEmbeddingProviderAsync -- the embedding PORT -- so the provider every downstream
   *  consumer shares (indexVault, indexNote, the query encoder, the advisory sweep, everything) is
   *  guarded before construction completes. */
  excludeFilter?: EgressFilter;
  /** Test-only: fires with each layer's name, in the order its cleanup ran. Only invoked when a
   *  later step throws during construction — never on the happy path, never by production callers. */
  onCleanup?: (name: OwnedLayer["name"]) => void;
}

export interface RuntimeCore {
  governance: Governance;
  indexResources: IndexResources;
}
