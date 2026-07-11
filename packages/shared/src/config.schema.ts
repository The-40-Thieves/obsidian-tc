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
  // THE-295: per-vault ACL override (same shape as the root `acl` block); absent -> the root
  // ACL is the inherited default. z.lazy defers the reference (AclConfigSchema is declared
  // below this schema).
  acl: z.lazy(() => AclConfigSchema).optional(),
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
    // THE-297 — asymmetric verification (RS256/ES256/EdDSA) behind the TokenVerifier seam.
    // `jwks` is an inline JWKS document; `jwksFile` a path loaded once at transport boot (file
    // or inline only — no URL fetch: no new network attack surface). Key rotation = multiple
    // keys in the set, selected by the token's `kid` header (jose). HS256 stays available
    // beside it; alg-confusion is structurally impossible (HS256 verifies ONLY against
    // jwtSecret, asymmetric algs ONLY against the JWKS).
    jwks: z.record(z.string(), z.unknown()).optional(),
    jwksFile: z.string().optional(),
    algorithms: z.array(z.string()).optional(),
    // MCP 2025-11-25 / RFC 9728 Protected Resource Metadata (THE-278). All optional; the HS256 token
    // format is unchanged. When `resource` + at least one `authorizationServers` entry are set, the
    // HTTP transport advertises a spec-compliant PRM document + WWW-Authenticate challenge for the
    // OAuth 2.1 resource-server role. The authorization-server half (token issuance / DCR / OIDC)
    // stays out of scope until a real external AS exists.
    resource: z.string().url().optional(),
    authorizationServers: z.array(z.string().url()).optional(),
    resourceName: z.string().optional(),
    scopesSupported: z.array(z.string()).optional(),
  })
  .refine((c) => c.mode !== "jwt" || !!c.jwtSecret || !!c.jwks || !!c.jwksFile, {
    message: "auth.mode 'jwt' requires jwtSecret (>=32 chars) or a JWKS (jwks / jwksFile)",
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
  /** When true, an UNDEFINED readPaths whitelist fails CLOSED on the request path (read_note et
   *  al.), not just bridge enumeration (THE-268). Default false = M0 allow-all back-compat. */
  strictReadDefault: z.boolean().default(false),
});

/** THE-397: retrieval-fusion knobs (the first config-exposed retrieval section). */
export const RetrievalConfigSchema = z.object({
  /** RRF constant for graph_rrf fusion. Keep BELOW the stream pool size (~30): larger k lets
   *  overlapping low-rank noise outrank confident single-stream hits (measured: 10 beats 60 on
   *  every metric at n=32; 20 is indistinguishable from 60). */
  rrfK: z.number().int().positive().default(10),
});

/** THE-230: experiential-tier (membrane store, experiential.db) knobs. */
export const ExperientialConfigSchema = z.object({
  /** Append serve-path retrieval events (chunk id + rank + score + query text + surface) to
   *  chunk_retrievals in experiential.db — local-only telemetry that feeds the ACT-R activation
   *  recompute and flywheel usage stats. Eval-harness runs call the search cores directly and
   *  never log (THE-187 eval/serve hygiene). false keeps the experiential handle closed after
   *  boot provisioning (pre-THE-230 behavior). */
  logRetrievals: z.boolean().default(true),
  /** THE-228: capture every dispatch outcome as an agent_episodes row (action axis: tool,
   *  status, duration, sizes, hashes, attribution — no payloads). Local-only work-memory in
   *  experiential.db; the sleep-time evaluator stamps retrieval-eligibility. */
  captureEpisodes: z.boolean().default(true),
  /** THE-228 content axis: also persist the raw parsed args (secret-scanned + size-capped)
   *  on each episode. Default OFF until the THE-238 poisoning defense lands — the write-on
   *  gate ordering. */
  captureContent: z.boolean().default(false),
});

export const EmbeddingsConfigSchema = z.object({
  provider: z.enum(["ollama", "openai", "voyage", "cohere", "bge-m3"]).default("ollama"),
  model: z.string().default("nomic-embed-text"),
  dimensions: z.number().int().positive().default(768),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  // GH #171/#172: local-runner indexing robustness. Local models are far slower than hosted APIs,
  // and a stock local runner (llama-server) crashes on a token-dense batch, so these are
  // configurable with local-safe defaults. `timeoutMs` bounds each embed request (was a hardcoded
  // 30s with no knob). `batchSize` caps inputs/request; `maxBatchTokens` caps a request's estimated
  // tokens (chars/4) so a dense sub-batch is split before it overruns a local runner's budget (a
  // single over-budget text still goes alone). `concurrency` is how many embed requests run in flight.
  // THE-390: `maxBatchTokens` must stay UNDER the provider's loaded context — Ollama defaults to
  // n_ctx 4096 and 400-rejects a request whose summed tokens exceed it, and the chars/4 estimate
  // undercounts real tokenization (~2-2.5x on link-dense markdown). 2048 estimated keeps a batch
  // inside a 4096 context with that drift; the indexer also bisects + retries a rejected batch,
  // so an occasional overshoot costs a retry, not the reindex.
  timeoutMs: z.number().int().positive().default(120000),
  batchSize: z.number().int().positive().default(512),
  maxBatchTokens: z.number().int().positive().default(2048),
  concurrency: z.number().int().positive().default(4),
  // THE-387: Matryoshka (MRL) dimension truncation. When true, a provider that returns vectors
  // WIDER than `dimensions` is truncated to the first `dimensions` components + renormalised (so a
  // wide MRL model such as Qwen3-8B at 4096 can be stored at 1024). Off by default; a non-MRL width
  // mismatch still errors rather than silently truncating meaningless prefixes.
  truncate: z.boolean().default(false),
  /** THE-406: contextual chunk enrichment. When true, each chunk is embedded and BM25-indexed as
   *  "{note title}{ — heading breadcrumb}\n\n{content}" instead of the bare section text — the
   *  chunker strips heading lines into metadata, so title/heading-only evidence is otherwise
   *  invisible to both retrieval streams. Display content (chunks.content) stays raw. The chunk
   *  content hash covers the enriched text, so flipping this re-embeds the vault on the next
   *  reconcile. DEFAULT ON since THE-408: measured +0.223 nDCG@10 (p=0.0001) with the divergence
   *  rebuild now enrichment-aware. UPGRADE NOTE: an index built with the flag off re-embeds in
   *  full on the first reconcile after upgrading (hash change) — set `chunkContext: false` to
   *  keep the old representation. */
  chunkContext: z.boolean().default(true),
  /** THE-405: asymmetric instruct prefixes for models whose cards require them (e.g.
   *  Qwen3-Embedding's "Instruct: ...\nQuery: " on the query side, documents plain). Applied at
   *  the provider factory: `queryPrefix` on embeds marked input:"query", `documentPrefix` on
   *  everything else (indexing). BOTH default empty — nomic-style prefixes measured HARMFUL on
   *  this vault (2026-07-11), so nothing changes unless a config opts in. Changing
   *  `documentPrefix` re-embeds nothing by itself (hashes cover chunk text, not the prefix) —
   *  pair a document-prefix change with a fresh cacheDir. */
  queryPrefix: z.string().default(""),
  documentPrefix: z.string().default(""),
});

export const HttpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8765),
  // DNS-rebinding / cross-origin protection (THE-271). On by default: reject a request whose Host is
  // neither loopback nor operator-allowed, or whose Origin (browsers always send one) is not the same
  // origin or operator-allowed. Server-to-server clients send no Origin and are unaffected.
  enableDnsRebindingProtection: z.boolean().default(true),
  allowedHosts: z.array(z.string()).default([]),
  allowedOrigins: z.array(z.string()).default([]),
});

export const TransportsConfigSchema = z.object({
  stdio: z.boolean().default(true),
  http: HttpConfigSchema.prefault({}),
});

export const GovernorConfigSchema = z.object({
  maxResponseBytes: z.number().int().positive().default(1_000_000),
  // THE-293: worker-time budget (ms) for one search_regex / search_vault(mode:regex) call.
  // Only regex execution in the worker counts — file I/O does not — so a benign pattern on a
  // large vault cannot false-positive the ReDoS guard.
  regexTimeoutMs: z.number().int().positive().default(2000),
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

// THE-252: write-safety policy. requireCas gates compare-and-swap on the destructive write paths.
export const WritesConfigSchema = z
  .object({
    // When true, write_note (overwrite) and append_note to an existing note REQUIRE a prev_hash
    // (compare-and-swap) and fail closed with invalid_input when it is absent, so a stale or absent
    // hash cannot silently clobber. Default off; the non-configurable hard default is deferred to a major.
    requireCas: z.boolean().default(false),
  })
  .prefault({});
export type WritesConfig = z.infer<typeof WritesConfigSchema>;

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

// THE-374: point-in-time snapshot policy. When enabled, destructive note writes first capture
// the prior state (content-addressed) so restore_note can roll back; retention caps versions/note.
export const SnapshotsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    retention: z.number().int().positive().max(1000).default(10),
  })
  .prefault({});
export type SnapshotsConfig = z.infer<typeof SnapshotsConfigSchema>;

// THE-292 — periodic cache.db maintenance sweep (expired idempotency/elicit rows + event_log
// retention + PRAGMA optimize). Fully defaulted: a config predating it validates unchanged.
export const MaintenanceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().positive().default(60),
  })
  .prefault({});

// THE-296 — ambient sleep-time consolidation (synthesis + audit jobs). Fully defaulted; only
// meaningful when the inference gateway (roles) is configured — cli gates on both.
export const PlaneConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().positive().default(240),
  })
  .prefault({});

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
  // THE-208: local plur bridge. plur ships no HTTP read-API (CLI + stdio-MCP + a local YAML
  // store); when `command` is set the plur read tools shell out to the local plur CLI instead
  // of the (Enterprise-only) HTTP endpoint. argv prefix, e.g. ["plur"] or
  // ["node", "/abs/@plur-ai/cli/dist/index.js"]. Takes precedence over `endpoint`.
  command: z.array(z.string().min(1)).min(1).optional(),
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
// tool surface (back-compat); "domain" advertises ~a dozen domain meta-tools (THE-275). Every registered
// tool stays callable by name regardless of mode, so nothing is removed.
export const ToolFacadeConfigSchema = z.object({
  mode: z.enum(["triad", "domain", "flat"]).default("triad"),
});
export type ToolFacadeConfig = z.infer<typeof ToolFacadeConfigSchema>;

// Session-bootstrap routing (THE-101). Server-level, not per-vault: the routing table is a
// judgment value supplied by config, never baked into the public tree. session_bootstrap triages
// the opening message to lightweight | standard | deep and reads the resolved context notes. A
// `domain` matches when any of its lowercased `signals` is a substring of the message, pulling its
// `paths`; `deepPaths` load in deep mode; a `deepPhrases` hit forces deep on a catch-up opener.
// Fully defaulted (empty table + generic catch-up phrases), so a config predating THE-101 validates
// unchanged and the tool degrades to lightweight with nothing to load.
export const BootstrapDomainSchema = z.object({
  name: z.string().min(1),
  signals: z.array(z.string().min(1)).min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export type BootstrapDomain = z.infer<typeof BootstrapDomainSchema>;

export const DEFAULT_DEEP_PHRASES = [
  "where did we leave off",
  "what's open",
  "whats open",
  "catch me up",
  "current state",
  "where are we",
  "what should i be working on",
  "what should i work on",
];

export const BootstrapConfigSchema = z
  .object({
    deepPaths: z.array(z.string().min(1)).default([]),
    domains: z.array(BootstrapDomainSchema).default([]),
    maxPaths: z.number().int().positive().max(50).default(10),
    deepPhrases: z.array(z.string().min(1)).default(DEFAULT_DEEP_PHRASES),
  })
  .prefault({});
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

const ServerConfigObject = z.object({
  cacheDir: z.string().default(".obsidian-tc"),
  vaults: z.array(VaultConfigSchema).min(1),
  plur: PlurConfigSchema.optional(),
  auth: AuthConfigSchema.prefault({ mode: "none" }),
  acl: AclConfigSchema.prefault({}),
  embeddings: EmbeddingsConfigSchema.prefault({}),
  retrieval: RetrievalConfigSchema.prefault({}),
  experiential: ExperientialConfigSchema.prefault({}),
  transports: TransportsConfigSchema.prefault({}),
  governor: GovernorConfigSchema.prefault({}),
  writes: WritesConfigSchema,
  toolVisibility: ToolVisibilityConfigSchema.optional(),
  toolFacade: ToolFacadeConfigSchema.prefault({}),
  bootstrap: BootstrapConfigSchema,
  throttle: ThrottleConfigSchema,
  observability: ObservabilityConfigSchema.prefault({}),
  maintenance: MaintenanceConfigSchema,
  snapshots: SnapshotsConfigSchema,
  plane: PlaneConfigSchema,
  idempotencyTtlSeconds: z.number().int().positive().default(86400),
  // THE-293: window (seconds) after which a crashed in-flight idempotency row may be reclaimed
  // at dispatch. Raise for legitimately slow bulk tools; lowering it below a live tool's
  // runtime risks a duplicate execution.
  idempotencyReclaimSeconds: z.number().int().positive().default(60),
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
