import { z } from "zod";
import { AclConfigSchema, AclRuleSchema, AuthConfigSchema } from "./config/auth-acl.schema";
import {
  EmbeddingsConfigSchema,
  type IndexingConfig,
  IndexingConfigSchema,
} from "./config/indexing-embeddings.schema";
import {
  MaintenanceConfigSchema,
  ObservabilityConfigSchema,
  PlaneConfigSchema,
  PlurConfigSchema,
  SchedulerConfigSchema,
  SnapshotsConfigSchema,
  WatchConfigSchema,
} from "./config/observability.schema";
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
// WP1.6: observability/snapshots/maintenance/watch/scheduler/plane/plur schemas now live in
// ./config/observability.schema.ts.
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
  MaintenanceConfigSchema,
  MetadataPriorRuleSchema,
  ObservabilityConfigSchema,
  PlaneConfigSchema,
  PlurConfigSchema,
  RankingConfigSchema,
  RetrievalConfigSchema,
  SchedulerConfigSchema,
  SnapshotsConfigSchema,
  ThrottleConfigSchema,
  TransportsConfigSchema,
  VaultBridgesConfigSchema,
  VaultCommandsConfigSchema,
  VaultConfigSchema,
  VaultMemoryConfigSchema,
  VaultPluginsConfigSchema,
  VaultWorkspaceConfigSchema,
  WatchConfigSchema,
  WritesConfigSchema,
};

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
