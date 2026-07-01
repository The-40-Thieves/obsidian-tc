import { z } from "zod";
import { isLoopbackHost } from "./net-host";

// Per-vault plugin-bridge timeouts (M4 / THE-180, G2.2 §3.1 + §6). Inner fields
// carry defaults; the whole block is optional so a vault that predates M4
// validates unchanged (consumers read `vault.bridges?.x ?? <default>`).
export const VaultBridgesConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(5000),
  probeTimeoutMs: z.number().int().positive().default(500),
  ocrTimeoutMs: z.number().int().positive().default(30000),
  templaterTimeoutMs: z.number().int().positive().default(30000),
});

// Per-vault probe overrides (M4 / THE-180, G2.2 §6). force_enabled/disabled treat
// a plugin as installed/missing regardless of the probe; probe_skip skips the
// startup probe entirely (force_enabled is then the source of truth) — the seam
// CI uses to assert tool behavior without a live Obsidian.
export const VaultPluginsConfigSchema = z.object({
  forceEnabled: z.array(z.string()).default([]),
  forceDisabled: z.array(z.string()).default([]),
  probeSkip: z.boolean().default(false),
});

// Per-vault command-palette execution policy (M4 / THE-180, G2.1 Domain 26).
// Deny-by-default: execute_command is disabled unless `enabled` is explicitly true,
// and even then only ids in `allowlist` may be fired (and only with a HITL token —
// execute:command is a scope floor). Arbitrary command execution is never silent.
export const VaultCommandsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowlist: z.array(z.string()).default([]),
});

// Per-vault memory-entity materialization config (M5 / THE-181, G2.1 Domain 22).
// Optional + back-compat: a vault predating M5 validates unchanged (consumers read
// `vault.memory?.folder ?? "memory"`). `folder` is where create_entity(materialize)
// writes the regenerable .md projection — a normal vault folder so the [[link]]
// graph resolves in Obsidian. SQLite stays the source of truth.
export const VaultMemoryConfigSchema = z.object({
  folder: z.string().min(1).default("memory"),
});

// Per-vault workspace-session trace config (M5 / THE-181, G2.1 Domain 23). Session
// traces are append-only JSONL written vault-relative (path-safe via resolveVaultPath
// + ACL-checked via enforcePathAcl) under this folder; default a dot-folder so they
// stay out of Obsidian's graph view. (G2.3 sketched cache_dir; THE-181's DoD requires
// ACL-checked, hence vault-relative.)
export const VaultWorkspaceConfigSchema = z.object({
  traceFolder: z.string().min(1).default(".obsidian-tc/traces"),
});

export const VaultConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  path: z.string().min(1),
  restApiUrl: z.string().url().optional(),
  restApiKey: z.string().optional(),
  // Headless mode selection (THE-255). Absent or `auto` probes the Local REST API once at
  // startup: reachable -> live (full surface), else headless (direct-atomic-fs vault state;
  // Tier-3 action tools degrade to requires_live_obsidian). `live`/`headless` force the mode
  // and skip the probe. Optional, so a config predating THE-255 validates unchanged;
  // resolveMode treats an absent mode as auto.
  mode: z.enum(["live", "headless", "auto"]).optional(),
  bridges: VaultBridgesConfigSchema.optional(),
  plugins: VaultPluginsConfigSchema.optional(),
  commands: VaultCommandsConfigSchema.optional(),
  memory: VaultMemoryConfigSchema.optional(),
  workspace: VaultWorkspaceConfigSchema.optional(),
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

export const AuthConfigSchema = z
  .object({
    mode: z.enum(["none", "jwt"]).default("none"),
    jwtSecret: z.string().min(32).optional(),
    tokenTtlSeconds: z.number().int().positive().default(86400),
  })
  .refine((c) => c.mode !== "jwt" || !!c.jwtSecret, {
    message: "jwtSecret (>=32 chars) is required when auth.mode is 'jwt'",
    path: ["jwtSecret"],
  });

export const AclRuleSchema = z.object({
  glob: z.string().min(1),
  scopes: z.array(z.string()).default([]),
});

export const AclConfigSchema = z.object({
  readOnly: z.boolean().default(false),
  defaultScopes: z.array(z.string()).default([]),
  rules: z.array(AclRuleSchema).default([]),
  // Per-path operation ACL (G2.2 section 5 / G2.4). Optional and back-compatible:
  // when a field is omitted that operation kind is unrestricted (M0 behavior);
  // when present it is a glob whitelist — a path must match at least one entry.
  // camelCase mirrors the rest of the config (readOnly, defaultScopes).
  readPaths: z.array(z.string()).optional(),
  writePaths: z.array(z.string()).optional(),
  deletePaths: z.array(z.string()).optional(),
});

export const EmbeddingsConfigSchema = z.object({
  provider: z.enum(["ollama", "openai", "voyage", "cohere"]).default("ollama"),
  model: z.string().default("nomic-embed-text"),
  dimensions: z.number().int().positive().default(768),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const HttpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8765),
});

export const TransportsConfigSchema = z.object({
  stdio: z.boolean().default(true),
  http: HttpConfigSchema.prefault({}),
});

export const GovernorConfigSchema = z.object({
  maxResponseBytes: z.number().int().positive().default(1_000_000),
});

// Per-scope-class throttle tiers + write-concurrency ceiling (THE-182 / M6, G2.4
// §Rate limits). Additive + fully defaulted, so a config predating M6 validates
// unchanged. The M6 bulk tools enforce the `bulk` tier (10/min, burst 3); the
// other tiers are reported by get_server_config and reserved for the M7
// dispatch-wide rate-limit gate. get_server_config surfaces these as its `limits`
// block (non-secret).
const throttleTier = (perMinute: number, burst: number) =>
  z
    .object({
      perMinute: z.number().int().positive().default(perMinute),
      burst: z.number().int().positive().default(burst),
    })
    .prefault({});

export const ThrottleConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    tiers: z
      .object({
        read: throttleTier(600, 100),
        write: throttleTier(60, 20),
        delete: throttleTier(60, 20),
        bulk: throttleTier(10, 3),
        execute: throttleTier(5, 1),
        admin: throttleTier(5, 1),
      })
      .prefault({}),
    maxConcurrentWritesPerVault: z.number().int().positive().default(16),
  })
  .prefault({});
export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;

// Observability config (G2.4 §Observability — finalized in M7/THE-183). Three opt-in
// export streams plus retention, all fully defaulted so a config predating M7 validates
// unchanged. OTEL is a no-op unless `otel.endpoint` is set; the Prometheus `/metrics`
// endpoint stays disabled until `prometheus.enabled`; MORGIANA spools CloudEvents JSONL
// by default and HTTP-pushes only when `morgiana.httpEndpoint` is set. camelCase mirrors
// the rest of the config. (M6 shipped a placeholder `otel: boolean` / `morgiana: {mode}`
// shape; M7 finalizes it to the G2.4 shape before the v1.0 additive-only freeze.)
export const ObservabilityConfigSchema = z.object({
  traceDetail: z.enum(["standard", "verbose"]).default("standard"),
  tracesSampleRate: z.number().min(0).max(1).default(1),
  otel: z
    .object({
      endpoint: z.string().url().optional(),
      headers: z.record(z.string(), z.string()).prefault({}),
    })
    .prefault({}),
  prometheus: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(0).max(65535).default(9464),
      bind: z.string().default("127.0.0.1"),
    })
    .prefault({}),
  morgiana: z
    .object({
      spool: z.boolean().default(true),
      httpEndpoint: z.string().url().optional(),
      httpHeaders: z.record(z.string(), z.string()).prefault({}),
    })
    .prefault({}),
  retention: z
    .object({
      morgianaEventsDays: z.number().int().positive().default(90),
      tracesDays: z.number().int().positive().default(90),
      eventLogDays: z.number().int().positive().default(30),
    })
    .prefault({}),
});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

// plur read-API proxy config (M5 / THE-181, G2.1 Domain 24). GLOBAL, not per-vault:
// the plur engram store is global and the plur tools take no `vault` argument, so
// this lives at the server root. endpoint/apiKey come from config or the
// OBSIDIAN_TC_PLUR_ENDPOINT / OBSIDIAN_TC_PLUR_TOKEN env vars (resolved in
// config/load.ts); the bearer is placed solely in the Authorization header by the
// bridge transport — never logged, never in an error/audit payload. Optional with
// inner defaults: when `endpoint` is absent the plur tools degrade to plugin_missing
// with NO network call.
export const PlurConfigSchema = z.object({
  endpoint: z.string().url().optional(),
  apiKey: z.string().optional(),
  apiPrefix: z.string().default(""),
  timeoutMs: z.number().int().positive().default(5000),
});
export type PlurConfig = z.infer<typeof PlurConfigSchema>;

// Static tool-visibility scoping (THE-219 — parity with turbovault's tool_visibility).
// Shapes the *advertised* tool surface at the Registry.listVisible()/dispatch chokepoints
// without rebuilding capability. Two strengths, with precedence disabled > hidden > listed:
//   - hidden / hiddenTags / requireReadOnly / allowed: drop a tool from tools/list, but it
//     stays callable by name (a lean default surface, not a security boundary).
//   - disabled / disabledTags: drop it from tools/list AND reject it at dispatch, so it
//     behaves as if unregistered.
// `allowed`, when present, is a name allowlist: only those tools are listed (absent = list
// all; an empty array lists none). `requireReadOnly` derives mutation from the required
// scopes (isMutatingScope), so it needs no per-tool annotation. Optional + fully defaulted:
// a config predating THE-219 validates unchanged and an absent block means ALLOW_ALL.
export const ToolVisibilityConfigSchema = z.object({
  allowed: z.array(z.string()).optional(),
  hidden: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
  hiddenTags: z.array(z.string()).default([]),
  disabledTags: z.array(z.string()).default([]),
  requireReadOnly: z.boolean().default(false),
});
export type ToolVisibilityConfig = z.infer<typeof ToolVisibilityConfigSchema>;

// Tool-surface facade (THE-219 consolidation). Which surface tools/list advertises: "triad" (the
// default) exposes three meta-tools (find/describe/call_capability); "flat" advertises the full
// tool surface (back-compat); "domain" is reserved for the domain-verb facade. Every registered
// tool stays callable by name regardless of mode, so nothing is removed.
export const ToolFacadeConfigSchema = z.object({
  mode: z.enum(["triad", "domain", "flat"]).default("triad"),
});
export type ToolFacadeConfig = z.infer<typeof ToolFacadeConfigSchema>;

const ServerConfigObject = z.object({
  cacheDir: z.string().default(".obsidian-tc"),
  vaults: z.array(VaultConfigSchema).min(1),
  plur: PlurConfigSchema.optional(),
  auth: AuthConfigSchema.prefault({ mode: "none" }),
  acl: AclConfigSchema.prefault({}),
  embeddings: EmbeddingsConfigSchema.prefault({}),
  transports: TransportsConfigSchema.prefault({}),
  governor: GovernorConfigSchema.prefault({}),
  toolVisibility: ToolVisibilityConfigSchema.optional(),
  toolFacade: ToolFacadeConfigSchema.prefault({}),
  throttle: ThrottleConfigSchema,
  observability: ObservabilityConfigSchema.prefault({}),
  idempotencyTtlSeconds: z.number().int().positive().default(86400),
  elicitTtlSeconds: z.number().int().positive().default(300),
});

// F2 fail-closed interlock: never run an unauthenticated server on a routable host. When the
// HTTP transport is enabled on a non-loopback host with auth.mode "none", every request would
// resolve to full wildcard scopes (see transports/http.ts resolveAuth) — refuse the config.
export const ServerConfigSchema = ServerConfigObject.superRefine((cfg, ctx) => {
  const http = cfg.transports.http;
  if (http.enabled && cfg.auth.mode === "none" && !isLoopbackHost(http.host)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transports", "http", "host"],
      message: `refusing to expose an unauthenticated server: transports.http.enabled is true with host "${http.host}" (non-loopback) while auth.mode is "none". Set auth.mode to "jwt" (with jwtSecret) or bind transports.http.host to a loopback address (127.0.0.1, ::1, localhost).`,
    });
  }
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
