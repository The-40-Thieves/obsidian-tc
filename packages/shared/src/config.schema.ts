import { z } from "zod";

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

export const VaultConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  path: z.string().min(1),
  restApiUrl: z.string().url().optional(),
  restApiKey: z.string().optional(),
  bridges: VaultBridgesConfigSchema.optional(),
  plugins: VaultPluginsConfigSchema.optional(),
  commands: VaultCommandsConfigSchema.optional(),
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

export const AuthConfigSchema = z
  .object({
    mode: z.enum(["none", "jwt", "oauth"]).default("none"),
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
  http: HttpConfigSchema.default({}),
});

export const GovernorConfigSchema = z.object({
  maxResponseBytes: z.number().int().positive().default(1_000_000),
});

export const ObservabilityConfigSchema = z.object({
  otel: z.boolean().default(false),
  prometheus: z
    .object({ enabled: z.boolean().default(false), port: z.number().int().default(9464) })
    .default({}),
  morgiana: z
    .object({
      mode: z.enum(["off", "jsonl", "http"]).default("jsonl"),
      endpoint: z.string().url().optional(),
    })
    .default({}),
});

export const ServerConfigSchema = z.object({
  cacheDir: z.string().default(".obsidian-tc"),
  vaults: z.array(VaultConfigSchema).min(1),
  auth: AuthConfigSchema.default({ mode: "none" }),
  acl: AclConfigSchema.default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  transports: TransportsConfigSchema.default({}),
  governor: GovernorConfigSchema.default({}),
  observability: ObservabilityConfigSchema.default({}),
  idempotencyTtlSeconds: z.number().int().positive().default(86400),
  elicitTtlSeconds: z.number().int().positive().default(300),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
