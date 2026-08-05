// Domain 28 — Server admin, remaining surface (G2.1 / THE-182). Three read-only
// inspection tools that complete the admin family beyond M1's registry tools
// (list_vaults/get_vault/reload_vault/reset_vault_cache) and M2's index_vault:
// get_server_config, inspect_acl, get_metrics. All take an `admin:*` scope, which
// is neither a HITL floor nor a mutating family, so they need no elicit token and
// run under a read-only ACL. They are non-secret by construction: this module only
// ever reads counts, booleans, names, and config limits — never the JWT secret,
// REST API keys, or embedding API keys (those are not even in M6Deps).
import { parseScope, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../db/types";
import type { ToolDefinition } from "../../mcp/registry";
import { explainVisibility } from "../../mcp/visibility";
import { evaluatePathAcl, pathScopesSatisfied } from "../../vault/acl-path";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M6Deps } from "./shared";

// ── metrics aggregation ──────────────────────────────────────────────────────

interface Metric {
  name: string;
  type: "counter" | "gauge";
  value: number;
  labels: Record<string, string>;
}

/**
 * THE-507: the ingest events that carry a COUNT rather than a single occurrence.
 *
 * `result_size` holds the count for these rows: a pass that skipped 3 secrets writes ONE row worth
 * 3, not three rows. event_log retention is time-based (observability.retention.eventLogDays), so
 * row COUNT is the unbounded axis — letting an indexing pass write one row per skipped chunk would
 * make event_log grow with vault size on every reconcile.
 */
const INGEST_EVENT_METRICS: Record<string, string> = {
  ingest_secrets_skipped: "obsidian_tc_ingest_secrets_skipped_total",
  ingest_dedup_skipped: "obsidian_tc_ingest_dedup_skipped_total",
  // THE-588: the unresolved (loss) side of dedup, alongside its reused sibling above.
  ingest_dedup_unresolved: "obsidian_tc_ingest_dedup_unresolved_total",
  embed_batch_rejections: "obsidian_tc_embed_batch_rejections_total",
  index_write_failures: "obsidian_tc_index_write_failures_total",
};

function ingestCounters(db: Database, vault?: string): Metric[] {
  const types = Object.keys(INGEST_EVENT_METRICS);
  const placeholders = types.map(() => "?").join(", ");
  const rows = (
    vault
      ? db
          .prepare(
            `SELECT vault_id, event_type, SUM(result_size) AS n FROM event_log WHERE event_type IN (${placeholders}) AND vault_id = ? GROUP BY vault_id, event_type`,
          )
          .all(...types, vault)
      : db
          .prepare(
            `SELECT vault_id, event_type, SUM(result_size) AS n FROM event_log WHERE event_type IN (${placeholders}) GROUP BY vault_id, event_type`,
          )
          .all(...types)
  ) as Array<{ vault_id: string | null; event_type: string; n: number | null }>;
  return rows.map((r) => ({
    name: INGEST_EVENT_METRICS[r.event_type] as string,
    type: "counter",
    value: r.n ?? 0,
    labels: { vault: r.vault_id ?? "" },
  }));
}

function invocationCounters(db: Database, vault?: string): Metric[] {
  // THE-507: event_type filter. event_log is NOT a tool-call log — it also carries `sweep_run`,
  // `morgiana_emit_dropped` and (now) the ingest counters above. Grouping over every row reported
  // those as tool calls that never happened, with an empty `tool` label; adding ingest events to the
  // same table would have compounded it. Only `tool_invocation` (writeEvent's default, set by the
  // registry for real dispatches) is a tool call.
  const rows = (
    vault
      ? db
          .prepare(
            "SELECT vault_id, tool_name, status, COUNT(*) AS n FROM event_log WHERE event_type = 'tool_invocation' AND vault_id = ? GROUP BY vault_id, tool_name, status",
          )
          .all(vault)
      : db
          .prepare(
            "SELECT vault_id, tool_name, status, COUNT(*) AS n FROM event_log WHERE event_type = 'tool_invocation' GROUP BY vault_id, tool_name, status",
          )
          .all()
  ) as Array<{ vault_id: string | null; tool_name: string | null; status: string; n: number }>;
  return rows.map((r) => ({
    // Catalog-aligned name (G2.4 / THE-211): get_metrics is the persistent event_log JSON view
    // of the same tool-call counter the in-memory /metrics recorder exposes. The M6 name
    // (obsidian_tc_tool_invocations_total) predated the finalized catalog.
    name: "obsidian_tc_tool_calls_total",
    type: "counter",
    value: r.n,
    labels: { vault: r.vault_id ?? "", tool: r.tool_name ?? "", status: r.status },
  }));
}

// ── tools ────────────────────────────────────────────────────────────────────

const InspectAclInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    op: z.enum(["read", "write", "delete", "execute"]),
    scopes: z.array(z.string()).default([]),
  })
  .strict();

/** Does any held scope cover the op's family (family wildcard or "*" included)? */
function scopeFamilyGranted(scopes: string[], op: string): boolean {
  return scopes.some((s) => {
    if (s === "*") return true;
    const { family } = parseScope(s);
    return family === "*" || family === op;
  });
}

// THE-417: written from get_server_config's return statement, not from ThrottleConfig's own
// declaration site — `throttle_tiers` mirrors ThrottleConfig["tiers"] verbatim, but `limits` picks
// three fields back out of the SAME config object under different names (max_operations_per_second
// is t.tiers.bulk.burst, not a distinct config value).
const TierLimits = z.object({ perMinute: z.number(), burst: z.number() });

const GetServerConfigOutput = z.object({
  version: z.string(),
  auth_mode: z.enum(["none", "jwt"]),
  read_only: z.boolean(),
  embeddings_provider: z.string(),
  vaults_summary: z.array(z.object({ id: z.string() })),
  limits: z.object({
    max_concurrent_writes_per_vault: z.number(),
    max_operations_per_second: z.number(),
    max_operations_per_minute: z.number(),
  }),
  throttle_tiers: z.object({
    read: TierLimits,
    write: TierLimits,
    delete: TierLimits,
    bulk: TierLimits,
    execute: TierLimits,
    admin: TierLimits,
  }),
  governor: z.object({ max_response_bytes: z.number() }),
  observability: z.object({
    otlp_enabled: z.boolean(),
    prometheus_enabled: z.boolean(),
    morgiana_enabled: z.boolean(),
  }),
  plugins_detected: z.record(z.string(), z.array(z.string())),
});

/** inspect_acl: five early returns that TypeScript widens to one shape (same pattern as m7/m8's
 *  multi-arm tools) — `denied_by` is the only field that is ever absent (the success arm). `${op}
 *  _paths` only ever fires for read/write/delete: execute is not path-scoped, so its only denial
 *  path is the read_only kill switch checked before evaluatePathAcl runs. */
const InspectAclOutput = z.object({
  allowed: z.boolean(),
  denied_by: z
    .enum(["read_only", "read_paths", "write_paths", "delete_paths", "scope", "path_scope"])
    .optional(),
  kill_switch: z.boolean(),
  matched_rule: z.string().nullable(),
  effective_scopes: z.array(z.string()),
});

// THE-645 item 2 — inspect_visibility. `tool` omitted classifies the whole surface; `scopes`
// omitted gates on the static config alone (the "what does the server itself hide" question),
// which is why it is optional rather than defaulted to [] — an empty grant is a real and
// different question from no grant at all.
const InspectVisibilityInput = z
  .object({
    tool: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    read_only: z.boolean().optional(),
    /** Narrows the returned list only. `summary` always covers the whole surface. */
    visibility: z.enum(["listed", "hidden", "disabled", "scope_denied"]).optional(),
  })
  .strict();

const InspectVisibilityEntry = z.object({
  name: z.string(),
  domain: z.string().nullable(),
  visibility: z.enum(["listed", "hidden", "disabled", "scope_denied", "unregistered"]),
  reason: z.string(),
  matched_tag: z.string().nullable(),
  missing_scopes: z.array(z.string()),
  required_scopes: z.array(z.string()),
  tags: z.array(z.string()),
});

const InspectVisibilityOutput = z.object({
  /** null when no hypothetical caller was supplied — the verdicts are static-config only. */
  evaluated_for: z.object({ scopes: z.array(z.string()), read_only: z.boolean() }).nullable(),
  summary: z.object({
    listed: z.number(),
    hidden: z.number(),
    disabled: z.number(),
    scope_denied: z.number(),
  }),
  tools: z.array(InspectVisibilityEntry),
});

const MetricSchema = z.object({
  name: z.string(),
  type: z.enum(["counter", "gauge"]),
  value: z.number(),
  labels: z.record(z.string(), z.string()),
});

const GetMetricsOutput = z.object({ metrics: z.array(MetricSchema) });

export function buildAdminTools(deps: M6Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_server_config",
      domain: "admin",
      description:
        "Read the non-secret server config: auth mode, server-global read_only + embeddings provider, throttle limits, observability targets, and a per-vault summary (id) plus a detected-plugins map. Never returns secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: GetServerConfigOutput,
      requiredScopes: ["admin:config"],
      handler: (_input, ctx) => {
        const t = deps.throttle;
        const pluginsDetected: Record<string, string[]> = {};
        for (const v of deps.vaultRegistry.list()) {
          const snap = deps.capabilities?.(v.id);
          pluginsDetected[v.id] = snap
            ? Object.entries(snap.plugins)
                .filter(([, cap]) => cap.installed)
                .map(([name]) => name)
                .sort()
            : [];
        }
        return {
          version: deps.version,
          auth_mode: deps.authMode,
          // Server-global: one FolderAcl + one embeddings provider for all vaults
          // (cli.ts), so these are top-level rather than misleadingly per-vault.
          read_only: ctx.acl?.readOnly ?? false,
          embeddings_provider: deps.embeddingsProvider,
          vaults_summary: deps.vaultRegistry.list().map((v) => ({ id: v.id })),
          // The three spec'd limits headline the bulk tier (the only class M6
          // enforces): per-minute = sustained rate, per-second = burst capacity.
          // Full per-class detail follows under throttle_tiers (additive).
          limits: {
            max_concurrent_writes_per_vault: t.maxConcurrentWritesPerVault,
            max_operations_per_second: t.tiers.bulk.burst,
            max_operations_per_minute: t.tiers.bulk.perMinute,
          },
          throttle_tiers: t.tiers,
          governor: { max_response_bytes: deps.governorMaxResponseBytes },
          observability: {
            otlp_enabled: deps.observability.otel,
            prometheus_enabled: deps.observability.prometheus,
            morgiana_enabled: deps.observability.morgiana,
          },
          plugins_detected: pluginsDetected,
        };
      },
    }),

    defineTool({
      name: "inspect_acl",
      domain: "admin",
      description:
        "Test whether a (vault, path, op, scopes) tuple would be permitted. Shares the live path evaluator (read-only kill switch + per-op whitelist) so it cannot drift from enforcement, then checks the op-family scope grant and the path-required rule-scopes (P1.4: a matching rule's scopes must all be held). Reports the matched path rule, the rule-based effective_scopes, and what denied it.",
      inputSchema: InspectAclInput,
      outputSchema: InspectAclOutput,
      requiredScopes: ["admin:acl"],
      handler: (input, ctx) => {
        deps.vaultRegistry.resolve(input.vault); // vault_not_found if unknown
        const rel = normalizeVaultPath(input.path);
        const acl = ctx.acl;
        const effective_scopes = acl?.scopesForPath(rel) ?? [];

        // execute is not path-scoped, but it IS a mutating family — live dispatch's
        // read-only kill switch still blocks it, so mirror that here (review #3).
        if (input.op === "execute" && acl?.readOnly)
          return {
            allowed: false,
            denied_by: "read_only",
            kill_switch: true,
            matched_rule: null,
            effective_scopes,
          };

        // 1 + 2. read-only kill switch AND per-op path whitelist, via the SAME pure
        //        evaluator enforcePathAcl delegates to (no reimplementation). execute
        //        is not path-scoped, so only the scope grant below applies.
        let matchedRule: string | null = null;
        if (input.op !== "execute") {
          const decision = evaluatePathAcl(acl, input.op, rel);
          matchedRule = decision.matchedGlob;
          if (!decision.allowed) {
            const killSwitch = decision.deniedBy === "read_only";
            return {
              allowed: false,
              denied_by: killSwitch ? "read_only" : `${input.op}_paths`,
              kill_switch: killSwitch,
              matched_rule: matchedRule,
              effective_scopes,
            };
          }
        }

        // 3. op-family scope grant (held scopes cover the op family or a wildcard).
        if (!scopeFamilyGranted(input.scopes, input.op))
          return {
            allowed: false,
            denied_by: "scope",
            kill_switch: false,
            matched_rule: matchedRule,
            effective_scopes,
          };

        // 4. P1.4: rule-scopes are load-bearing — the caller must hold every scope the path's rule
        //    declares (Require semantics). Mirrors the central dispatch enforcement so this
        //    diagnostic cannot drift from what a real call would do.
        if (!pathScopesSatisfied(acl, rel, input.scopes))
          return {
            allowed: false,
            denied_by: "path_scope",
            kill_switch: false,
            matched_rule: matchedRule,
            effective_scopes,
          };

        return { allowed: true, matched_rule: matchedRule, kill_switch: false, effective_scopes };
      },
    }),

    defineTool({
      name: "inspect_visibility",
      domain: "admin",
      description:
        "Explain why a tool is or is not offered to a caller: returns listed | hidden | disabled | scope_denied | unregistered per tool, plus the RULE that decided it (which name/tag list matched, which required scopes are missing). Pass `scopes`/`read_only` to evaluate a hypothetical caller the way inspect_acl does, `tool` to ask about one, or `visibility` to filter. Shares the registry's own classifier and config, so it cannot drift from what tools/list does. admin:acl-scoped BY DESIGN: distinguishing hidden from unregistered is exactly the existence oracle the unauthenticated surface refuses to be.",
      inputSchema: InspectVisibilityInput,
      outputSchema: InspectVisibilityOutput,
      requiredScopes: ["admin:acl"],
      handler: (input) => {
        // Unwired deps must FAIL, not return an empty surface. A tool that answers "0 tools, none
        // hidden" when it simply was not given the registry is a false clean bill of health — the
        // `dense: ready` shape (THE-688). Every other M6 dep defaults to a benign zero; this one
        // cannot, because zero is a meaningful answer here.
        const surface = deps.toolSurface?.();
        if (!surface)
          throw new Error(
            "inspect_visibility: tool surface not wired (M6Deps.toolSurface); cannot classify",
          );

        const evaluatedFor =
          input.scopes === undefined
            ? null
            : { scopes: [...input.scopes], read_only: input.read_only ?? false };
        const caller =
          evaluatedFor === null
            ? undefined
            : { grantedScopes: evaluatedFor.scopes, readOnly: evaluatedFor.read_only };

        // One tool asked for by name, and it is not registered. This is the branch that makes the
        // admin scope load-bearing: `unregistered` and `hidden` are deliberately indistinguishable
        // on the public surface (both return not_found at dispatch), and telling them apart is the
        // whole feature. Never widen this tool's scope without re-reading THE-645 item 2.
        if (input.tool !== undefined && !surface.tools.some((t) => t.name === input.tool)) {
          return {
            evaluated_for: evaluatedFor,
            summary: { listed: 0, hidden: 0, disabled: 0, scope_denied: 0 },
            tools: [
              {
                name: input.tool,
                domain: null,
                visibility: "unregistered" as const,
                reason: "not_registered",
                matched_tag: null,
                missing_scopes: [],
                required_scopes: [],
                tags: [],
              },
            ],
          };
        }

        const classified = surface.tools.map((t) => {
          const e = explainVisibility(t, surface.config, caller);
          return {
            name: t.name,
            domain: t.domain ?? null,
            visibility: e.visibility,
            reason: e.reason,
            matched_tag: e.matchedTag,
            missing_scopes: [...e.missingScopes],
            required_scopes: [...t.requiredScopes],
            tags: [...(t.tags ?? [])],
          };
        });

        // Summary counts the WHOLE surface, never the filtered view — a filter is a lens on the
        // answer, not a change to it, and a count that moved with the filter would misreport the
        // deployment's posture.
        const summary = { listed: 0, hidden: 0, disabled: 0, scope_denied: 0 };
        for (const c of classified) summary[c.visibility] += 1;

        const tools = classified.filter(
          (c) =>
            (input.tool === undefined || c.name === input.tool) &&
            (input.visibility === undefined || c.visibility === input.visibility),
        );

        return {
          evaluated_for: evaluatedFor,
          summary,
          tools,
        };
      },
    }),

    defineTool({
      name: "get_metrics",
      domain: "admin",
      description:
        "Snapshot Prometheus-style metrics as structured JSON: per-(vault,tool,status) invocation counters and rate-limit-hit counters aggregated from the local event_log + live limiter, plus uptime/registered-vault/registered-tool gauges. Optionally filter to one vault.",
      inputSchema: z.object({ vault: VaultId.optional() }).strict(),
      outputSchema: GetMetricsOutput,
      requiredScopes: ["admin:metrics"],
      handler: (input, ctx) => {
        const now = (ctx.now ?? Date.now)();
        const metrics: Metric[] = [
          ...invocationCounters(ctx.db, input.vault),
          // THE-507: ingest work counters, additive to the stderr lines the indexer already writes.
          ...ingestCounters(ctx.db, input.vault),
        ];

        for (const row of deps.rateLimiter.snapshot()) {
          if (input.vault && row.vault !== input.vault) continue;
          metrics.push({
            name: "obsidian_tc_rate_limit_hits_total",
            type: "counter",
            value: row.hits,
            labels: { vault: row.vault, scope_class: row.scope_class },
          });
        }

        metrics.push(
          {
            name: "obsidian_tc_vaults_registered",
            type: "gauge",
            value: deps.vaultRegistry.list().length,
            labels: {},
          },
          {
            name: "obsidian_tc_tools_registered",
            type: "gauge",
            value: deps.registeredTools?.() ?? 0,
            labels: {},
          },
          {
            name: "obsidian_tc_uptime_seconds",
            type: "gauge",
            value: Math.max(0, Math.floor((now - deps.startedAt) / 1000)),
            labels: {},
          },
        );

        return { metrics };
      },
    }),
  ];
}
