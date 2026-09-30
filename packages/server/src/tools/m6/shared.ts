// Shared wiring for the M6 tools (THE-182): bulk operations (Domain 25), URI
// generation (Domain 27), and the remaining server-admin surface (Domain 28).
// M6Deps is injected once in cli.ts onto the same ToolRegistry as M0-M5, so the M6
// tools light up on both the stdio and HTTP edges. The RateLimiter is a single
// shared instance: the bulk tools consume its `bulk` tier and get_metrics reads its
// hit counters. All admin-reporting fields are non-secret by construction (no JWT
// secret, no REST/embedding API keys).
import type { ThrottleConfig, VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { CapabilitySnapshot } from "../../bridge";
import type { EffectiveToolVisibilityConfig } from "../../mcp/visibility";
import type { MetricsRecorder } from "../../metrics/registry";
import type { RateLimiter } from "../../throttle";
import type { VaultRegistry } from "../../vault/registry";
import type { RerunResult } from "../../workspace/rerun";

/**
 * `session_rerun`'s per-call sandbox runtime: stage a disposable copy of `vaultId`'s vault, build
 * a SECOND, scoped `ServerRuntime` against it, re-issue `sessionId`'s recorded calls under
 * `replayScopes` (never wider — see `intersectReplayScopes`, workspace/rerun.ts), then dispose
 * it, aborting and disposing if `timeoutMs` elapses first. Defined as a closure and threaded in
 * from `runtime/server-runtime.ts` (its `runSandboxSessionRerun`) rather than imported here: no
 * module reachable from THIS domain's own wiring can import `buildServerRuntime` without a cycle
 * back to the composition root.
 */
export type SandboxRerunFn = (params: {
  vaultId: string;
  sessionId: string;
  replayScopes: readonly string[];
  timeoutMs: number;
}) => Promise<RerunResult>;

export interface M6Deps {
  vaultRegistry: VaultRegistry;
  /** THE-291: index-on-write hooks for the bulk writers (best-effort, backgrounded). */
  reindex?: (vaultId: string, path: string, content: string) => void;
  deindex?: (vaultId: string, path: string) => void;
  /** per-vault memoryDefense policy for bulk_create_notes/bulk_set_property/
   *  bulk_move_notes — the SAME closure/metrics M1/M5/M8 already get. Absent -> MEMORY_DEFENSE_OFF
   *  (mode "off", no scan). */
  memoryDefense?: (vaultId: string) => VaultMemoryDefenseConfig;
  metrics?: MetricsRecorder;
  /** Shared rate limiter: bulk tools consume the `bulk` tier; get_metrics reads hits. */
  rateLimiter: RateLimiter;
  /** Build version (get_server_config / get_metrics). */
  version: string;
  /** Process start epoch ms (get_metrics uptime gauge). */
  startedAt: number;
  /** Configured auth mode (get_server_config) — never the secret itself. */
  authMode: "none" | "jwt" | "oidc";
  /** Throttle config block; get_server_config reports its limits. */
  throttle: ThrottleConfig;
  /** Observability toggles (get_server_config) — booleans only, no endpoints/tokens. */
  observability: { otel: boolean; prometheus: boolean; morgiana: boolean };
  /** Embeddings provider name (get_server_config vault summary) — not the API key. */
  embeddingsProvider: string;
  /** Response-byte governor ceiling (get_server_config). */
  governorMaxResponseBytes: number;
  /** Per-vault plugin-capability snapshot for plugins_detected (get_server_config). */
  capabilities?: (vaultId: string) => CapabilitySnapshot;
  /** Count of registered tools (get_metrics gauge); evaluated lazily after wiring. */
  registeredTools?: () => number;
  /**
   * THE-645 item 2: the live tool surface plus the visibility config the registry classifies
   * with, for `inspect_visibility`. Lazily evaluated for the same reason `registeredTools` is —
   * the registry does not exist yet when M6Deps is constructed.
   *
   * Deliberately returns the registry's OWN config object rather than re-reading the server
   * config: `inspect_visibility` answers "what would tools/list do", and an inspector that reads
   * a different copy of the rules than the enforcer answers a different question. Same reasoning
   * as `inspect_acl` sharing the live path evaluator.
   */
  toolSurface?: () => {
    config: EffectiveToolVisibilityConfig;
    tools: readonly ToolSurfaceEntry[];
  };
  /** `session_rerun`'s per-call sandbox runtime — see SandboxRerunFn. Optional so a test wiring
   *  only a subset of M6Deps is unaffected; `session_rerun` degrades to a clear "not configured"
   *  error rather than reaching for the live vault as a fallback (mirrors `toolSurface` above). */
  rerun?: SandboxRerunFn;
  /** Session traces live under it (`trace_store = 'cache'`); `session_rerun`'s confirmation binds
   *  to the recorded trace there. Absent -> the binding covers the session row only. */
  cacheDir?: string;
}

/** The slice of a ToolDefinition that visibility classification needs, plus `domain` for grouping. */
export interface ToolSurfaceEntry {
  name: string;
  domain?: string;
  tags?: readonly string[];
  requiredScopes: readonly string[];
}
