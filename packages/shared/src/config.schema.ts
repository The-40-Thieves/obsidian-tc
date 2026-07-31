import { z } from "zod";
import { AclConfigSchema, AclRuleSchema, AuthConfigSchema } from "./config/auth-acl.schema";
import {
  EmbeddingsConfigSchema,
  type IndexingConfig,
  IndexingConfigSchema,
} from "./config/indexing-embeddings.schema";
import {
  ExperientialConfigSchema,
  MetadataPriorRuleSchema,
  RankingConfigSchema,
  RetrievalConfigSchema,
} from "./config/retrieval.schema";
import {
  GovernorConfigSchema,
  HttpConfigSchema,
  type ThrottleConfig,
  ThrottleConfigSchema,
  TransportsConfigSchema,
  WritesConfigSchema,
} from "./config/runtime.schema";
import type { VaultConfig, VaultConfigInput, VaultKind } from "./config/vault.schema";
import {
  DEFAULT_MEMORY_FOLDER,
  VaultBridgesConfigSchema,
  VaultCommandsConfigSchema,
  VaultConfigSchema,
  VaultMemoryConfigSchema,
  VaultPluginsConfigSchema,
  VaultWorkspaceConfigSchema,
} from "./config/vault.schema";
import { isLoopbackHost } from "./net-host";

export type { IndexingConfig, ThrottleConfig, VaultConfig, VaultConfigInput, VaultKind };
// WP1.1: auth+ACL schemas now live in ./config/auth-acl.schema.ts.
// WP1.2: vault schemas now live in ./config/vault.schema.ts.
// WP1.3: retrieval/ranking/experiential schemas now live in ./config/retrieval.schema.ts.
// WP1.4: embeddings/indexing schemas now live in ./config/indexing-embeddings.schema.ts.
// WP1.5: http/transports/governor/throttle/writes schemas now live in ./config/runtime.schema.ts.
// All are re-exported here so this stays a compatibility facade and every existing import of
// these names keeps working.
export {
  AclConfigSchema,
  AclRuleSchema,
  AuthConfigSchema,
  DEFAULT_MEMORY_FOLDER,
  EmbeddingsConfigSchema,
  ExperientialConfigSchema,
  GovernorConfigSchema,
  HttpConfigSchema,
  IndexingConfigSchema,
  MetadataPriorRuleSchema,
  RankingConfigSchema,
  RetrievalConfigSchema,
  ThrottleConfigSchema,
  TransportsConfigSchema,
  VaultBridgesConfigSchema,
  VaultCommandsConfigSchema,
  VaultConfigSchema,
  VaultMemoryConfigSchema,
  VaultPluginsConfigSchema,
  VaultWorkspaceConfigSchema,
  WritesConfigSchema,
};

// Observability config (G2.4 §Observability — finalized in M7/THE-183). Three opt-in
// export streams plus retention, all fully defaulted so a config predating M7 validates
// unchanged. OTEL is a no-op unless `otel.endpoint` is set; the Prometheus `/metrics`
// endpoint stays disabled until `prometheus.enabled`; MORGIANA spools CloudEvents JSONL
// by default and HTTP-pushes only when `morgiana.httpEndpoint` is set. camelCase mirrors
// the rest of the config. (M6 shipped a placeholder `otel: boolean` / `morgiana: {mode}`
// shape; M7 finalizes it to the G2.4 shape before the v1.0 additive-only freeze.)
export const ObservabilityConfigSchema = z.object({
  // traceDetail / tracesSampleRate were declared here and read by NOTHING: no sampling was ever applied
  // and no detail switch existed. Removed rather than left as a lie in a schema operators trust. Re-add
  // them together with the code that honors them.
  otel: z
    .object({
      endpoint: z
        .string()
        .url()
        .optional()
        .describe("OTLP collector endpoint. OpenTelemetry export is a no-op until this is set."),
      headers: z
        .record(z.string(), z.string())
        .prefault({})
        .describe(
          "Extra headers sent with OTLP exports, e.g. an auth token. Values may be secret.",
        ),
    })
    .prefault({})
    .describe("OpenTelemetry trace export."),
  prometheus: z
    .object({
      enabled: z.boolean().default(false).describe("Serve the Prometheus /metrics endpoint."),
      port: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .default(9464)
        .describe("Port for the Prometheus scrape endpoint."),
      bind: z
        .string()
        .default("127.0.0.1")
        .describe(
          "Bind address for the scrape endpoint. Loopback by default — /metrics is unauthenticated.",
        ),
    })
    .prefault({})
    .describe("Prometheus metrics endpoint."),
  morgiana: z
    .object({
      spool: z.boolean().default(true).describe("Write CloudEvents to a local JSONL spool file."),
      httpEndpoint: z
        .string()
        .url()
        .optional()
        .describe("Push CloudEvents to this URL. Absent means spool-only, with no network calls."),
      httpHeaders: z
        .record(z.string(), z.string())
        .prefault({})
        .describe("Extra headers sent with event pushes. Values may be secret."),
    })
    .prefault({})
    .describe("CloudEvents export stream."),
  retention: z
    .object({
      // morgianaEventsDays was declared and read by nothing and stays removed — the morgiana spool
      // still has no retention. tracesDays was removed for the same reason and is RE-ADDED here by
      // THE-610, which implemented the filesystem arm the original key was missing.
      eventLogDays: z
        .number()
        .int()
        .positive()
        .default(30)
        .describe(
          "Days of event_log rows kept by the maintenance sweep. The morgiana event spool is still not pruned and grows without bound.",
        ),
      tracesDays: z
        .number()
        .int()
        .positive()
        .default(30)
        .describe(
          "Days of workspace session trace files (<vault>/<traceFolder>/*.jsonl) kept by the maintenance sweep. Traces are per-vault and live INSIDE the vault, so they are also picked up by whatever syncs or backs it up. Orphans from a failed start_session are pruned by the same age rule (THE-572 writes the trace before the session row, so a failed attempt leaves a file with no row referencing it).",
        ),
    })
    .prefault({})
    .describe("Retention policy for locally stored observability data."),
});
// THE-374: point-in-time snapshot policy. When enabled, destructive note writes first capture
// the prior state (content-addressed) so restore_note can roll back; retention caps versions/note.
export const SnapshotsConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Capture the prior content-addressed state before a destructive note write, so restore_note can roll back. On by default under the trusted-local posture; retention is pruned inline, so growth is bounded.",
      ),
    retention: z
      .number()
      .int()
      .positive()
      .max(1000)
      .default(10)
      .describe("Maximum snapshot versions kept per note. Older versions are pruned."),
  })
  .prefault({});
// THE-292 — periodic cache.db maintenance sweep (expired idempotency/elicit rows + event_log
// retention + PRAGMA optimize). Fully defaulted: a config predating it validates unchanged.
export const MaintenanceConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Run the periodic cache.db maintenance sweep (expired idempotency and elicitation rows, event_log retention, PRAGMA optimize).",
      ),
    intervalMinutes: z
      .number()
      .int()
      .positive()
      .default(60)
      .describe("Minutes between maintenance sweeps."),
    // THE-571: the durable queue never pruned finished rows, so `jobs` grew without bound. Only
    // TERMINAL rows are swept -- queued/running/retrying are live work regardless of age.
    jobsCompleteRetentionDays: z
      .number()
      .int()
      .positive()
      .default(7)
      .describe(
        "Days a COMPLETE job row is retained before the maintenance sweep prunes it. Must stay LONGER than the longest producer dedup window: enqueue() dedups against a terminal row unless replaceIfTerminal is set, so pruning one frees its idempotency key and lets that period run again (the weekly synthesis is the longest today).",
      ),
    // THE-610 arm 2: the experiential store's two growth curves. Only DEAD episodes (forget
    // tombstones and bi-temporally expired rows) are ever pruned — a live episode is work memory
    // and age says nothing about whether it is finished with.
    // THE-458 item 6: a PERIODIC vault reconcile. Off unless set, because a server whose watcher
    // is healthy does not need it — but two gaps opened when THE-649 made the watcher the primary
    // change source, and this is the only thing that closes either short of a manual index_vault:
    //   * the watcher is not started on Windows at all, can fail to arm (inotify ENOSPC), sees
    //     nothing on some network mounts, and never covers vaults added later by add_vault;
    //   * indexNote does NOT densify, so the watcher's single-note writes leave derived edges
    //     stale until a full pass runs. This pass threads densify exactly as the boot one does.
    reconcileIntervalMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Minutes between periodic full vault reconciles. ABSENT (the default) disables it: the boot reconcile and the filesystem watch already cover a healthy server. Set it when the watch cannot run — Windows (where it is never started), a network mount with no change notification, or a vault large enough to exhaust the inotify limit — and when derived graph edges should be refreshed, since single-note writes never densify. Costs a full vault walk per run; content-hash skip makes an unchanged vault cheap to re-walk but densification still runs.",
      ),
    episodesRetentionDays: z
      .number()
      .int()
      .positive()
      .default(90)
      .describe(
        "Days a DEAD agent_episodes row (a forget tombstone, or one whose valid_until has passed) is retained before the maintenance sweep prunes it. Live episodes are never pruned at any age. Keep this long enough to still answer 'was this forgotten?' after the fact.",
      ),
    retrievalsRetentionDays: z
      .number()
      .int()
      .positive()
      .default(365)
      .describe(
        "Days a chunk_retrievals row is retained. NOT purely disk hygiene: chunk_access_stats is a VIEW over this table, so pruning REWRITES access_count / last_accessed_at / citations / outcome_balance, which feed activation and note quality. A short window makes a long-tail note that was genuinely useful look never-accessed. The default is deliberately a year, far above the other retention windows, so no signal any current consumer reads is affected.",
      ),
    jobsFailedRetentionDays: z
      .number()
      .int()
      .positive()
      .default(30)
      .describe(
        "Days a FAILED (dead-lettered) job row is retained. Longer than the complete-row window because these exist to be read; bounded by age, so a burst of failures inside the window is still unbounded in count.",
      ),
  })
  .prefault({});

// THE-649 — filesystem watch over each vault root. Fully defaulted, and defaulted ON: docs/SYNC.md
// has described this behaviour ("the server watches vaultPath and reindexes changed files") since
// before the watcher existed, so ON is the setting that makes the documented contract true rather
// than a new opt-in feature. Every sync tier in that document delivers Markdown by writing to disk,
// which is the only event this can observe.
export const WatchConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Watch each vault root and reindex notes changed outside the server (sync clients, git pull, an editor on the host). Not active on Windows regardless of this setting: Node's recursive fs.watch terminated the test process there, and whether a long-lived server is affected the same way is unverified. Turn OFF for a vault on a filesystem with no usable change notification (some network mounts) or to cap inotify usage on a very large vault; index_vault then remains the only way changes are picked up.",
      ),
    debounceMs: z
      .number()
      .int()
      .positive()
      .default(500)
      .describe(
        "Quiet period before a burst of filesystem events is flushed. One editor save emits several events and a sync pass emits one per file; this coalesces both into a single reindex per path. Raising it delays pickup, lowering it costs redundant reindex passes during a large sync.",
      ),
  })
  .prefault({});

// THE-458 item 6 — the shared background scheduler. One key today, and it exists because the
// feature behind it was built, tested and then unreachable: `eventLoopDeferMs` gates budget
// deferral (a due tick waits instead of piling onto a loop that is already behind), and cli.ts
// simply never passed it. `scheduler_deferred_total` was therefore pinned at 0 for every release
// since it shipped — the metric's own description says as much, honestly, which made it easy to
// read as "nothing to defer" rather than "no way to turn it on".
//
// Still DEFAULTED OFF (absent), so cadence is unchanged for every existing deployment. The change
// is that an operator can now reach it without editing source.
export const SchedulerConfigSchema = z
  .object({
    eventLoopDeferMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Event-loop delay p99 (ms) above which a DUE background tick is deferred rather than run. Deferred is not skipped: the tick runs on a later pass once the loop recovers, and obsidian_tc_scheduler_deferred_total counts it. Absent (the default) disables deferral entirely and the event-loop monitor is never even created, so there is no cost when off. Set it when background work is observably competing with request latency; a value near your acceptable p99 tail is the starting point.",
      ),
  })
  .prefault({});

// THE-296 — ambient sleep-time consolidation (synthesis + audit jobs). Fully defaulted; only
// meaningful when the inference gateway (roles) is configured — cli gates on both.
export const PlaneConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Run ambient sleep-time consolidation (synthesis and audit jobs). Only meaningful when the inference gateway roles are configured.",
      ),
    intervalMinutes: z
      .number()
      .int()
      .positive()
      .default(240)
      .describe("Minutes between consolidation passes."),
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
  endpoint: z
    .string()
    .url()
    .optional()
    .describe(
      "Base URL of the plur read API. When absent (and no `command` is set) the plur tools degrade to plugin_missing with NO network call.",
    ),
  apiKey: z
    .string()
    .optional()
    .describe(
      "Bearer token for the plur read API. Secret — placed only in the Authorization header, never logged or included in an error or audit payload.",
    ),
  apiPrefix: z.string().default("").describe("Path prefix prepended to plur API routes."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(5000)
    .describe("Timeout in ms for a plur read call."),
  // THE-208: local plur bridge. plur ships no HTTP read-API (CLI + stdio-MCP + a local YAML
  // store); when `command` is set the plur read tools shell out to the local plur CLI instead
  // of the (Enterprise-only) HTTP endpoint. argv prefix, e.g. ["plur"] or
  // ["node", "/abs/@plur-ai/cli/dist/index.js"]. Takes precedence over `endpoint`.
  command: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'argv prefix for shelling out to a local plur CLI instead of the HTTP endpoint, e.g. ["plur"]. Takes precedence over `endpoint`.',
    ),
});
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
  allowed: z
    .array(z.string())
    .optional()
    .describe(
      "Name allowlist: only these tools are listed. Absent lists all; an empty array lists none.",
    ),
  hidden: z
    .array(z.string())
    .default([])
    .describe(
      "Tool names dropped from tools/list but still callable by name. A leaner default surface, NOT a security boundary.",
    ),
  disabled: z
    .array(z.string())
    .default([])
    .describe(
      "Tool names dropped from tools/list AND rejected at dispatch, so they behave as if unregistered.",
    ),
  hiddenTags: z
    .array(z.string())
    .default([])
    .describe("Tags whose tools are hidden from tools/list but remain callable."),
  disabledTags: z
    .array(z.string())
    .default([])
    .describe("Tags whose tools are hidden and rejected at dispatch."),
  requireReadOnly: z
    .boolean()
    .default(false)
    .describe(
      "List only non-mutating tools. Mutation is derived from each tool's required scopes, so no per-tool annotation is needed. Hides rather than rejects.",
    ),
});
export type ToolVisibilityConfig = z.infer<typeof ToolVisibilityConfigSchema>;

// Tool-surface facade (THE-219 consolidation). Which surface tools/list advertises: "triad" (the
// default) exposes three meta-tools (find/describe/call_capability); "flat" advertises the full
// tool surface (back-compat); "domain" advertises ~a dozen domain meta-tools (landed under THE-275,
// which was itself cancelled — see facade.ts's note). Every registered tool stays callable by name
// regardless of mode, so nothing is removed.
//
// The "triad" default is a DECISION, not an accident, and re-litigating it has a specific bar:
// docs/adr/0006-the-default-surface-is-the-triad.md. Short version — 3 advertised tools is already
// leaner than every comparable server (market range 6-15), and switching to "domain" wants an
// eval that measures tool-SELECTION accuracy, which does not exist yet.
export const ToolFacadeConfigSchema = z.object({
  mode: z
    .enum(["triad", "domain", "flat"])
    .default("triad")
    .describe(
      "Which surface tools/list advertises: `triad` exposes three meta-tools (find/describe/call_capability), `domain` about a dozen domain meta-tools, `flat` the full tool surface. Every registered tool stays callable by name in every mode.",
    ),
});
// Session-bootstrap routing (THE-101). Server-level, not per-vault: the routing table is a
// judgment value supplied by config, never baked into the public tree. session_bootstrap triages
// the opening message to lightweight | standard | deep and reads the resolved context notes. A
// `domain` matches when any of its lowercased `signals` is a substring of the message, pulling its
// `paths`; `deepPaths` load in deep mode; a `deepPhrases` hit forces deep on a catch-up opener.
// Fully defaulted (empty table + generic catch-up phrases), so a config predating THE-101 validates
// unchanged and the tool degrades to lightweight with nothing to load.
export const BootstrapDomainSchema = z.object({
  name: z.string().min(1).describe("Label for this routing domain."),
  signals: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Lowercased substrings; the domain matches when any one appears in the opening message.",
    ),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Context notes loaded when this domain matches."),
});
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
    deepPaths: z
      .array(z.string().min(1))
      .default([])
      .describe("Context notes loaded additionally in deep mode."),
    domains: z
      .array(BootstrapDomainSchema)
      .default([])
      .describe(
        "Signal-to-path routing table. Empty means the tool degrades to lightweight with nothing to load.",
      ),
    maxPaths: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(10)
      .describe("Ceiling on how many context notes one bootstrap may read."),
    deepPhrases: z
      .array(z.string().min(1))
      .default(DEFAULT_DEEP_PHRASES)
      .describe("Catch-up phrases that force deep mode regardless of the triage result."),
  })
  .prefault({});
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

export const ServerConfigObject = z.object({
  // THE-526: a named security posture. "hardened" fills in the least-privilege field set
  // (strictReadDefault, requireCas, snapshots, HTTP off) before validation, with any explicitly-set
  // field winning — so "hardened, but with my paths" is one key plus overrides, not a hand-merge of
  // six fields across four sections. "trusted-local" is the permissive default, named so an operator
  // can SEE which posture they are on rather than inferring it. Absent === "trusted-local".
  securityProfile: z
    .enum(["hardened", "trusted-local"])
    .optional()
    .describe(
      "Named security posture applied before validation. 'hardened' sets the least-privilege defaults (strictReadDefault, requireCas, snapshots on, HTTP off); explicit fields override it. 'trusted-local' (the default) keeps the permissive single-user posture.",
    ),
  cacheDir: z
    .string()
    .default(".obsidian-tc")
    .describe(
      "Directory holding the derived index and caches. Everything in it is regenerable — deleting it forces a full reindex, it is never the source of truth.",
    ),
  vaults: z
    .array(VaultConfigSchema)
    .min(1)
    .describe("Vaults this server serves. At least one is required."),
  plur: PlurConfigSchema.optional().describe(
    "plur engram-store read proxy. Global rather than per-vault, since the plur store is global.",
  ),
  auth: AuthConfigSchema.prefault({ mode: "none" }).describe(
    "Authentication and token verification.",
  ),
  acl: AclConfigSchema.prefault({}).describe(
    "Default path ACL, inherited by any vault without its own.",
  ),
  embeddings: EmbeddingsConfigSchema.prefault({}).describe(
    "Embedding provider and indexing throughput.",
  ),
  indexing: IndexingConfigSchema.describe("Index-on-write concurrency and backpressure."),
  retrieval: RetrievalConfigSchema.prefault({}).describe(
    "Retrieval fusion and graph densification.",
  ),
  ranking: RankingConfigSchema.prefault({}).describe("Post-fusion ranking overlays."),
  experiential: ExperientialConfigSchema.prefault({}).describe(
    "Local-only experiential telemetry tier.",
  ),
  transports: TransportsConfigSchema.prefault({}).describe("Which MCP transports are served."),
  governor: GovernorConfigSchema.prefault({}).describe("Response-size and regex execution limits."),
  writes: WritesConfigSchema.describe("Write-safety policy."),
  toolVisibility: ToolVisibilityConfigSchema.optional().describe(
    "Static tool-surface scoping. Absent means allow all.",
  ),
  toolFacade: ToolFacadeConfigSchema.prefault({}).describe(
    "Which tool surface tools/list advertises.",
  ),
  bootstrap: BootstrapConfigSchema.describe("session_bootstrap context routing table."),
  throttle: ThrottleConfigSchema.describe("Per-scope-class rate limits and write concurrency."),
  observability: ObservabilityConfigSchema.prefault({}).describe(
    "Metrics, traces and event export.",
  ),
  maintenance: MaintenanceConfigSchema.describe("Periodic cache.db maintenance sweep."),
  scheduler: SchedulerConfigSchema.describe("Shared background scheduler tuning."),
  watch: WatchConfigSchema.describe("Filesystem watch that reindexes notes changed outside."),
  snapshots: SnapshotsConfigSchema.describe("Point-in-time note snapshot policy."),
  plane: PlaneConfigSchema.describe("Ambient sleep-time consolidation jobs."),
  idempotencyTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(86400)
    .describe(
      "Seconds an idempotency record is retained, bounding how long a repeated request key is deduplicated.",
    ),
  // THE-293: window (seconds) after which a crashed in-flight idempotency row may be reclaimed
  // at dispatch. Raise for legitimately slow bulk tools; lowering it below a live tool's
  // runtime risks a duplicate execution.
  idempotencyReclaimSeconds: z
    .number()
    .int()
    .positive()
    .default(60)
    .describe(
      "Seconds after which a crashed in-flight idempotency row may be reclaimed at dispatch. Raise it for legitimately slow bulk tools: setting it below a live tool's runtime risks executing that tool twice.",
    ),
  elicitTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(300)
    .describe(
      "Seconds a pending elicitation (human-in-the-loop prompt) stays valid before it expires.",
    ),
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
  // THE-456 (audit #3): a remote or JWKS-verified deployment MUST bind the token audience — warn-only
  // was insufficient. Without an audience, a token an issuer minted for a DIFFERENT service is accepted
  // here (confused deputy). The verifier treats the PRM `resource` as the audience when set, so an
  // explicit `audience` OR a `resource` satisfies the binding. HS256 on a loopback bind stays
  // audience-optional (self-issued, local); a JWKS (external issuer) is never audience-optional.
  if (cfg.auth.mode === "jwt") {
    // THE-658: jwksUri counts. It is the MOST external of the three key sources — keys fetched
    // from an authorization server at runtime — so leaving it out would have exempted exactly the
    // configuration that most needs an audience bound.
    const hasJwks = Boolean(cfg.auth.jwks || cfg.auth.jwksFile || cfg.auth.jwksUri);
    const boundAudience = cfg.auth.audience ?? cfg.auth.resource;
    const remote = http.enabled && !isLoopbackHost(http.host);
    if (hasJwks && boundAudience === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "audience"],
        message:
          "auth.mode 'jwt' with a JWKS (jwks/jwksFile/jwksUri) requires auth.audience (or auth.resource): a JWKS trusts an external issuer, so without an audience a token that issuer minted for another service is accepted here (confused deputy). (THE-456)",
      });
    }
    if (remote && boundAudience === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "audience"],
        message: `refusing a non-loopback jwt server without an audience: transports.http.host "${http.host}" is remote, so set auth.audience (or auth.resource) to bind tokens to this resource. Audience-optional HS256 is only allowed on a loopback bind. (THE-456)`,
      });
    }
    if (cfg.auth.issuer !== undefined && boundAudience === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "audience"],
        message:
          "auth.issuer is set (tokens from an external authorization server) but no audience is bound: require BOTH auth.issuer and auth.audience (or auth.resource) so this resource validates the token's issuer AND audience, not just its issuer. (THE-456)",
      });
    }
  }
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Render this schema as JSON Schema, for editors to consume on obsidian-tc.config.json.
 *
 * Lives here rather than in the generator script because THIS is the module that owns the schema
 * and can resolve `zod` — a script under scripts/ resolves imports from its own directory upward,
 * so it finds zod only when the workspace happens to hoist it to the root. That worked locally and
 * failed on the CI runner; putting the conversion where the dependency actually lives removes the
 * difference instead of papering over it.
 *
 * `io: "input"` is deliberate and is NOT the default. A config FILE is an input — what a human
 * writes before defaults and transforms apply. The default ("output") describes the post-parse
 * shape, marking every defaulted key required, which is precisely wrong for validating a file
 * someone is part-way through typing.
 */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ServerConfigSchema, { io: "input" }) as Record<string, unknown>;
}
