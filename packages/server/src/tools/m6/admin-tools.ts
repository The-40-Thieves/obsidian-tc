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
import { evaluatePathAcl } from "../../vault/acl-path";
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

function invocationCounters(db: Database, vault?: string): Metric[] {
  const rows = (
    vault
      ? db
          .prepare(
            "SELECT vault_id, tool_name, status, COUNT(*) AS n FROM event_log WHERE vault_id = ? GROUP BY vault_id, tool_name, status",
          )
          .all(vault)
      : db
          .prepare(
            "SELECT vault_id, tool_name, status, COUNT(*) AS n FROM event_log GROUP BY vault_id, tool_name, status",
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

export function buildAdminTools(deps: M6Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_server_config",
      description:
        "Read the non-secret server config: auth mode, server-global read_only + embeddings provider, throttle limits, observability targets, and a per-vault summary (id) plus a detected-plugins map. Never returns secrets.",
      inputSchema: z.object({}).strict(),
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
      description:
        "Test whether a (vault, path, op, scopes) tuple would be permitted. Shares the live path evaluator (read-only kill switch + per-op whitelist) so it cannot drift from enforcement, then checks the op-family scope grant. Reports the matched path rule, the rule-based effective_scopes, and what denied it.",
      inputSchema: InspectAclInput,
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

        return { allowed: true, matched_rule: matchedRule, kill_switch: false, effective_scopes };
      },
    }),

    defineTool({
      name: "get_metrics",
      description:
        "Snapshot Prometheus-style metrics as structured JSON: per-(vault,tool,status) invocation counters and rate-limit-hit counters aggregated from the local event_log + live limiter, plus uptime/registered-vault/registered-tool gauges. Optionally filter to one vault.",
      inputSchema: z.object({ vault: VaultId.optional() }).strict(),
      requiredScopes: ["admin:metrics"],
      handler: (input, ctx) => {
        const now = (ctx.now ?? Date.now)();
        const metrics: Metric[] = [...invocationCounters(ctx.db, input.vault)];

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
