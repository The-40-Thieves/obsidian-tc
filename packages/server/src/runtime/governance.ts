// WP5.1 (issue 15): run_serve's ACL / rate-limit / ToolRegistry wiring, extracted verbatim out of
// cli.ts — the dispatch-policy composition sitting between the stores (runtime/stores.ts) and the
// indexing/watcher wiring (runtime/indexing-wiring.ts) in the map's "stores -> governance ->
// indexing" order. `ToolRegistry` itself lives here (not in a later slice) because every option it
// takes IS a governance decision (ACL resolution, throttle, idempotency, HITL, audit) — tool
// REGISTRATION (the M1-M8 `register*Tools` calls) stays in cli.ts for WP5.2.
import type { Tracer } from "@opentelemetry/api";
import type { VaultConfigInput } from "@the-40-thieves/obsidian-tc-shared";
import { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import { elicitVerifier, setDefaultElicitTtlSeconds } from "../elicit";
import { ToolRegistry } from "../mcp/registry";
import type { RegistryOptions } from "../mcp/registry/types";
import type { MetricsRecorder } from "../metrics/registry";
import type { MorgianaEmitter } from "../morgiana/emitter";
import { RateLimiter, type ThrottleTiers } from "../throttle";
import { VaultRegistry } from "../vault/registry";
import {
  ActiveSessionTracker,
  appendTrace,
  getSession,
  resolveTraceAbs,
} from "../workspace/sessions";

export interface GovernanceDeps {
  db: Database;
  /** THE-737: where session traces live now (beside cache.db). The sessionTracer resolves a
   *  cache-store row against this instead of the vault root. */
  cacheDir: string;
  /** THE-736: `sessions.traceContent`. */
  traceContent?: boolean;
  /** config.vaults */
  vaults: VaultConfigInput[];
  /** config.acl — root ACL, inherited by any vault without its own. */
  acl: ConstructorParameters<typeof FolderAcl>[0];
  /** OBSIDIAN_TC_DEFAULT_VAULT */
  defaultVaultId: string | undefined;
  /** config.elicitTtlSeconds */
  elicitTtlSeconds: number;
  /** config.throttle */
  throttle: { enabled: boolean; tiers: ThrottleTiers };
  /** config.governor.maxResponseBytes */
  maxResponseBytes: number;
  /** config.idempotencyTtlSeconds */
  idempotencyTtlSeconds: number;
  /** config.idempotencyReclaimSeconds */
  idempotencyReclaimSeconds: number;
  toolVisibility: RegistryOptions["toolVisibility"];
  metrics: MetricsRecorder;
  tracer: Tracer | undefined;
  morgiana: Pick<MorgianaEmitter, "emit">;
  /** THE-228: present only when experiential.captureEpisodes. */
  onEpisode?: RegistryOptions["onEpisode"];
  /** THE-457: indexHealth is indexing-wiring's resource, constructed AFTER this registry (same
   *  forward-reference shape cli.ts already used for indexCoordinatorRef/schedulerRef) — a lazy
   *  accessor closes over it instead of taking a direct value. Only invoked at dispatch time, well
   *  after boot has finished constructing it. */
  getAuditWriteFailureCounter: () => { auditWriteFailures: number };
}

export interface Governance {
  acl: FolderAcl;
  aclByVault: Map<string, FolderAcl>;
  vaultRegistry: VaultRegistry;
  /** THE-209: process-local active-session tracker; start_session/end_session maintain it and the
   *  stdio context factory reads it to stamp ctx.sessionId for dispatch-level tracing. */
  activeSessions: ActiveSessionTracker;
  rateLimiter: RateLimiter;
  registry: ToolRegistry;
  /** No open resource to release — ACL/registry/rate-limiter objects are plain in-memory state.
   *  Present (as a no-op) so this wiring step participates in the same accumulate-and-unwind
   *  cleanup stack as stores/indexing (see server-runtime.ts) rather than being a silent exception. */
  close(): void;
}

/**
 * THE-295/THE-302/THE-210: build the root + per-vault ACLs, the shared rate limiter, the vault
 * registry, and the ToolRegistry with every dispatch-policy hook it was constructed with inline in
 * run_serve. `sessionTracer` and the ACL/root/vault-kind resolvers close over `vaultRegistry`,
 * constructed earlier in this same function — no forward reference needed there.
 */
export function wireGovernance(deps: GovernanceDeps): Governance {
  const acl = new FolderAcl(deps.acl);
  const aclByVault = new Map(
    deps.vaults
      .filter((v) => v.acl !== undefined)
      .map((v) => [v.id, new FolderAcl(v.acl as ConstructorParameters<typeof FolderAcl>[0])]),
  );
  const vaultRegistry = new VaultRegistry(deps.vaults, deps.defaultVaultId);
  const activeSessions = new ActiveSessionTracker();
  // THE-302: the configured elicit-token TTL governs every HITL token mint (issueElicitToken falls
  // back to this default when a caller passes no explicit ttlSeconds). Set once at startup.
  setDefaultElicitTtlSeconds(deps.elicitTtlSeconds);
  const rateLimiter = new RateLimiter(deps.throttle.tiers);
  const registry = new ToolRegistry({
    maxResponseBytes: deps.maxResponseBytes,
    idempotencyTtlSeconds: deps.idempotencyTtlSeconds,
    idempotencyReclaimSeconds: deps.idempotencyReclaimSeconds,
    verifyElicit: elicitVerifier,
    metrics: deps.metrics,
    tracer: deps.tracer,
    emit: (vaultId, type, data) => deps.morgiana.emit(vaultId, type, data),
    // THE-288: honor throttle.enabled — when false the dispatch gate gets no limiter and never
    // throttles. The RateLimiter object still exists (above) so get_metrics keeps reporting.
    rateLimiter: deps.throttle.enabled ? rateLimiter : undefined,
    toolVisibility: deps.toolVisibility,
    // THE-736: trace argument capture, off unless configured.
    traceContent: deps.traceContent,
    // THE-295: per-vault ACL enforcement at dispatch.
    aclResolver: (vaultId) => aclByVault.get(vaultId) ?? acl,
    // THE-414: vault-root resolver so dispatch can run central pathAcl enforcement with the same
    // symlink-canonical enforcePathAcl the handlers use. Unknown vaults resolve to undefined
    // (central enforcement then skips; the vault-binding guard already rejects cross-vault access).
    rootResolver: (vaultId) => {
      try {
        return vaultRegistry.resolve(vaultId).root;
      } catch {
        return undefined;
      }
    },
    // THE-569: reverse vault-kind gate — a mutating dispatch refuses to reach a docs/system-kind
    // vault, closing the write/integrity direction of P1.5. Unknown vaults resolve to undefined
    // (the gate then no-ops; the vault-binding guard and pathAcl stage already reject them).
    vaultKindResolver: (vaultId) => {
      try {
        return vaultRegistry.resolve(vaultId).kind;
      } catch {
        return undefined;
      }
    },
    // THE-209: append a per-invocation trace record to the active session's JSONL trace.
    sessionTracer: (session, record) => {
      try {
        const row = getSession(deps.db, session.sessionId);
        if (!row || row.ended_at !== null || row.vault_id !== session.vaultId) return;
        // THE-737: a row's store decides where its trace lives. Resolving every row against the
        // vault would send a cache-store trace to a vault path that does not exist -- and because
        // this whole block is best-effort, that failure would be swallowed and the trace silently
        // lost. One shared resolver, so this cannot drift from the session tools' reader.
        const abs = resolveTraceAbs({
          store: row.trace_store,
          tracePath: row.trace_path,
          cacheDir: deps.cacheDir,
          vaultRoot: vaultRegistry.resolve(row.vault_id).root,
        });
        appendTrace(abs, record);
      } catch {
        /* best-effort: tracing never breaks a dispatch */
      }
    },
    onProfile:
      process.env.OBSIDIAN_TC_PROFILE === "1"
        ? (p) =>
            process.stderr.write(
              `[profile] ${p.tool} total=${p.total_ms}ms handler=${p.handler_ms}ms overhead=${p.total_ms - p.handler_ms}ms\n`,
            )
        : undefined,
    // THE-288: a non-typed handler throw is redacted to `{code:"internal"}` for the client; the
    // real error + stack goes to stderr (never stdout, the MCP channel) for operator diagnosis.
    onInternalError: (tool, vaultId, e) => {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      process.stderr.write(`[internal] ${tool} (vault ${vaultId}): ${detail}\n`);
    },
    // THE-417 Phase 2: route drift to a counter so warn-mode has a readable output. The stderr
    // line above stays — it carries the Zod issues a human needs to diagnose; this is the half a
    // dashboard can alert on.
    onOutputSchemaDrift: (tool, vaultId) => deps.metrics.incOutputSchemaDrift(vaultId, tool),
    // THE-457: a fail-open audit write that threw is already metered; also bump the health counter
    // so server_health shows the audit trail going lossy. Runs only at dispatch (after indexHealth
    // is initialized).
    onAuditFailure: () => {
      deps.getAuditWriteFailureCounter().auditWriteFailures++;
    },
    // THE-228: every dispatch outcome feeds the experiential episode bus (when enabled).
    ...(deps.onEpisode ? { onEpisode: deps.onEpisode } : {}),
  });

  return {
    acl,
    aclByVault,
    vaultRegistry,
    activeSessions,
    rateLimiter,
    registry,
    close: () => {
      /* no owned resource */
    },
  };
}
