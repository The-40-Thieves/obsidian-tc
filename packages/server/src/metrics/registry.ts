// Prometheus metric catalog (G2.4 §Prometheus — THE-211 / THE-183). The exact 8 counters,
// 2 histograms, and 4 gauges from the observability spec, on a PRIVATE prom-client Registry
// (never the global default registry, so multiple recorders — e.g. in tests — never collide).
// The recorder is always live: counters are cheap in-memory adds and back both `get_metrics`
// and the optional `/metrics` scrape endpoint, which stays disabled by default (G2.4 `:0`).
//
// Cardinality is bounded exactly as G2.4 mandates: labels use `scope_class` (a family like
// `read`/`write`/`bulk`), never full scope strings, and the caller hash is deliberately NOT a
// label — caller-dimension breakdowns belong in OTEL spans and MORGIANA events, whose
// cardinality budgets are looser than Prometheus'.
//
// Coverage note (honest, per spec): every catalog name is registered so `/metrics` is
// catalog-complete, but two counters have no V1 emission source — `idempotency_hits_total`
// and `idempotency_cache_skipped_total` (idempotency replay is forward-compat, THE-197) — and
// the `idempotency_cache_bytes` gauge likewise. They expose as registered-zero until that
// subsystem lands; this is documented rather than faked.
import { Counter, Gauge, Histogram, Registry } from "prom-client";

/** Per-vault gauge sample sources, read lazily at scrape time (G2.4 gauges are per `vault`). */
export interface GaugeSources {
  activeSessions?: () => Array<{ vault: string; value: number }>;
  captureQueueDepth?: () => Array<{ vault: string; value: number }>;
  elicitTokensPending?: () => Array<{ vault: string; value: number }>;
  idempotencyCacheBytes?: () => Array<{ vault: string; value: number }>;
}

/** Terminal call status for `obsidian_tc_tool_calls_total` (matches the OTEL status attribute). */
export type ToolCallStatus = "ok" | "denied" | "error";

// Log-spaced byte buckets from G2.4 (1k, 10k, 100k, 1M, 10M).
const RESPONSE_BYTE_BUCKETS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];

export class MetricsRecorder {
  readonly registry: Registry;

  private readonly toolCalls: Counter<string>;
  private readonly aclDenied: Counter<string>;
  private readonly hitlElicited: Counter<string>;
  private readonly idempotencyHits: Counter<string>;
  private readonly idempotencyCacheSkipped: Counter<string>;
  private readonly rateLimitHits: Counter<string>;
  private readonly governorTruncations: Counter<string>;
  private readonly morgianaDropped: Counter<string>;
  private readonly auditWriteFailed: Counter<string>;
  private readonly toolDuration: Histogram<string>;
  private readonly responseBytes: Histogram<string>;

  constructor(sources: GaugeSources = {}) {
    const registry = new Registry();
    this.registry = registry;
    const registers = [registry];

    this.toolCalls = new Counter({
      name: "obsidian_tc_tool_calls_total",
      help: "Tool calls by vault, tool, and terminal status.",
      labelNames: ["vault", "tool", "status"],
      registers,
    });
    this.aclDenied = new Counter({
      name: "obsidian_tc_acl_denied_total",
      help: "ACL/scope denials by vault, scope class, and reason.",
      labelNames: ["vault", "scope_class", "reason"],
      registers,
    });
    this.hitlElicited = new Counter({
      name: "obsidian_tc_hitl_elicited_total",
      help: "HITL elicit confirmations required, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.auditWriteFailed = new Counter({
      name: "obsidian_tc_audit_write_failed_total",
      help: "Security-audit event writes that failed, by vault and tool. Audit is fail-open by design (a failed write must never break dispatch), so this counter is the only signal that the audit trail has gone lossy.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.idempotencyHits = new Counter({
      name: "obsidian_tc_idempotency_hits_total",
      help: "Idempotency cache hits, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.idempotencyCacheSkipped = new Counter({
      name: "obsidian_tc_idempotency_cache_skipped_total",
      help: "Idempotency results skipped over the byte cap, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.rateLimitHits = new Counter({
      name: "obsidian_tc_rate_limit_hits_total",
      help: "Rate-limit refusals, by vault and scope class.",
      labelNames: ["vault", "scope_class"],
      registers,
    });
    this.governorTruncations = new Counter({
      name: "obsidian_tc_governor_truncations_total",
      help: "Response-byte governor truncations/refusals, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.morgianaDropped = new Counter({
      name: "obsidian_tc_morgiana_emit_dropped_total",
      help: "MORGIANA events dropped, by vault and reason.",
      labelNames: ["vault", "reason"],
      registers,
    });

    this.toolDuration = new Histogram({
      name: "obsidian_tc_tool_duration_seconds",
      help: "Tool execution wall time in seconds, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
      // G2.4: "Default (Prometheus client library defaults)." — no explicit buckets.
    });
    this.responseBytes = new Histogram({
      name: "obsidian_tc_response_bytes",
      help: "Tool response size in bytes, by vault and tool.",
      labelNames: ["vault", "tool"],
      buckets: RESPONSE_BYTE_BUCKETS,
      registers,
    });

    // Gauges read live per-vault state at scrape time via injected sources. Registered
    // unconditionally so the catalog is complete on /metrics even before a source exists.
    const gauge = (
      name: string,
      help: string,
      source?: () => Array<{ vault: string; value: number }>,
    ): void => {
      new Gauge({
        name,
        help,
        labelNames: ["vault"],
        registers,
        collect() {
          if (!source) return;
          this.reset();
          for (const s of source()) this.set({ vault: s.vault }, s.value);
        },
      });
    };
    gauge(
      "obsidian_tc_active_sessions",
      "Active workspace sessions, by vault.",
      sources.activeSessions,
    );
    gauge(
      "obsidian_tc_capture_queue_depth",
      "Pending capture-queue items, by vault.",
      sources.captureQueueDepth,
    );
    gauge(
      "obsidian_tc_elicit_tokens_pending",
      "Unconsumed elicit tokens, by vault.",
      sources.elicitTokensPending,
    );
    gauge(
      "obsidian_tc_idempotency_cache_bytes",
      "Idempotency cache size in bytes, by vault.",
      sources.idempotencyCacheBytes,
    );
  }

  /** Record one terminal tool call: count + duration + response-size histograms. */
  observeToolCall(
    vault: string,
    tool: string,
    status: ToolCallStatus,
    durationSeconds: number,
    responseBytes: number,
  ): void {
    this.toolCalls.inc({ vault, tool, status });
    this.toolDuration.observe({ vault, tool }, durationSeconds);
    this.responseBytes.observe({ vault, tool }, responseBytes);
  }

  incAclDenied(vault: string, scopeClass: string, reason: string): void {
    this.aclDenied.inc({ vault, scope_class: scopeClass, reason });
  }
  incHitlElicited(vault: string, tool: string): void {
    this.hitlElicited.inc({ vault, tool });
  }
  incAuditWriteFailed(vault: string, tool: string): void {
    this.auditWriteFailed.inc({ vault, tool });
  }
  incIdempotencyHit(vault: string, tool: string): void {
    this.idempotencyHits.inc({ vault, tool });
  }
  incIdempotencyCacheSkipped(vault: string, tool: string): void {
    this.idempotencyCacheSkipped.inc({ vault, tool });
  }
  incRateLimitHit(vault: string, scopeClass: string): void {
    this.rateLimitHits.inc({ vault, scope_class: scopeClass });
  }
  incGovernorTruncation(vault: string, tool: string): void {
    this.governorTruncations.inc({ vault, tool });
  }
  incMorgianaDropped(vault: string, reason: string): void {
    this.morgianaDropped.inc({ vault, reason });
  }

  /** Prometheus text exposition (`text/plain; version=0.0.4`). */
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
  get contentType(): string {
    return this.registry.contentType;
  }
}
