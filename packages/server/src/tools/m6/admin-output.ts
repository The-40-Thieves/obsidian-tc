// Output contracts and `response_format` shapers for get_server_config and inspect_visibility
// (GH #1027). Kept out of admin-tools.ts, which sits at biome's line cap, so the concise shape
// lives beside the schema that has to mark its dropped fields optional.
import { z } from "zod";
import type { ResponseFormat } from "../response-format";

// THE-417: written from get_server_config's return statement, not from ThrottleConfig's own
// declaration site — `throttle_tiers` mirrors ThrottleConfig["tiers"] verbatim, but `limits` picks
// three fields back out of the SAME config object under different names (max_operations_per_second
// is t.tiers.bulk.burst, not a distinct config value).
const TierLimits = z.object({ perMinute: z.number(), burst: z.number() });

const DefaultResolution = z.object({
  value: z.number(),
  source: z.enum(["call", "config", "derived", "default"]),
});

// GH #1027: response_format=concise drops the per-class throttle detail (`limits` keeps the headline
// numbers), the observability toggles and the retrieval-defaults report, so those three are optional.
export const GetServerConfigOutput = z.object({
  version: z.string(),
  auth_mode: z.enum(["none", "jwt", "oidc"]),
  read_only: z.boolean(),
  embeddings_provider: z.string(),
  vaults_summary: z.array(z.object({ id: z.string() })),
  limits: z.object({
    max_concurrent_writes_per_vault: z.number(),
    max_operations_per_second: z.number(),
    max_operations_per_minute: z.number(),
  }),
  throttle_tiers: z
    .object({
      read: TierLimits,
      write: TierLimits,
      delete: TierLimits,
      bulk: TierLimits,
      execute: TierLimits,
      admin: TierLimits,
    })
    .optional(),
  // Which limiter backs the buckets and what happens when a shared one is down. Deliberately just
  // these two enums: throttle.redis (URL env name, file path, key prefix) never leaves config.
  throttle: z.object({
    backend: z.enum(["memory", "sqlite", "redis"]),
    failure_policy: z.enum(["fail-open", "fail-closed"]),
  }),
  governor: z.object({ max_response_bytes: z.number() }),
  observability: z
    .object({
      otlp_enabled: z.boolean(),
      prometheus_enabled: z.boolean(),
      morgiana_enabled: z.boolean(),
    })
    .optional(),
  plugins_detected: z.record(z.string(), z.array(z.string())),
  retrieval_defaults: z
    .object({
      derived_defaults_enabled: z.boolean(),
      knn_min_sim: DefaultResolution,
      vaults: z.array(
        z.object({
          id: z.string(),
          rrf_k: DefaultResolution,
          derived_rrf_k: z.number().nullable(),
          index_stats: z
            .object({
              chunk_count: z.number(),
              note_count: z.number(),
              edge_count: z.number(),
              avg_chunks_per_note: z.number(),
              edges_per_note: z.number(),
            })
            .nullable(),
        }),
      ),
    })
    .optional(),
});
export type ServerConfigReport = z.infer<typeof GetServerConfigOutput>;

/** The report for `format`: `full` unchanged for "detailed". Concise keeps every field a caller
 *  decides on or that qualifies the others (read_only, auth_mode, the limiter backend and its
 *  failure policy, the governor ceiling, the detected plugins). */
export function shapeServerConfig(full: ServerConfigReport, format: ResponseFormat) {
  if (format === "detailed") return full;
  return {
    version: full.version,
    auth_mode: full.auth_mode,
    read_only: full.read_only,
    embeddings_provider: full.embeddings_provider,
    vaults_summary: full.vaults_summary,
    limits: full.limits,
    throttle: full.throttle,
    governor: full.governor,
    plugins_detected: full.plugins_detected,
  };
}

// GH #1027: response_format=concise returns {name, visibility, reason} per tool, plus `matched_tag`
// and `missing_scopes` only when the verdict has one (the RULE that decided it), and drops `domain`,
// `required_scopes` and `tags`; so those five are optional here.
const InspectVisibilityEntry = z.object({
  name: z.string(),
  domain: z.string().nullable().optional(),
  visibility: z.enum(["listed", "hidden", "disabled", "scope_denied", "unregistered"]),
  reason: z.string(),
  matched_tag: z.string().nullable().optional(),
  missing_scopes: z.array(z.string()).optional(),
  required_scopes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export const InspectVisibilityOutput = z.object({
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
export type VisibilityReport = z.infer<typeof InspectVisibilityOutput>;

/** The report for `format`: `full` unchanged for "detailed". The summary always covers the whole
 *  surface, in either format. */
export function shapeVisibility(full: VisibilityReport, format: ResponseFormat) {
  if (format === "detailed") return full;
  return {
    evaluated_for: full.evaluated_for,
    summary: full.summary,
    tools: full.tools.map((t) => ({
      name: t.name,
      visibility: t.visibility,
      reason: t.reason,
      ...(t.matched_tag ? { matched_tag: t.matched_tag } : {}),
      ...(t.missing_scopes && t.missing_scopes.length > 0
        ? { missing_scopes: t.missing_scopes }
        : {}),
    })),
  };
}
