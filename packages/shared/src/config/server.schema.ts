// WP1.8: the final extraction — server.schema.ts is the composition point. It imports all seven
// sibling leaves (auth-acl, vault, retrieval, indexing-embeddings, runtime, observability, tools)
// and assembles the top-level ServerConfigObject/ServerConfigSchema, plus the one cross-domain
// refinement that has stayed in the facade through all seven prior slices (the http/auth
// unauthenticated-bind interlock) — it moves here because this is where the composed object that
// refinement reads (`cfg.transports.http` and `cfg.auth`) now lives. `../config.schema.ts` stays a
// pure re-export facade after this; this file must never import it back (that would be a cycle).
import { z } from "zod";
import { isLoopbackHost } from "../net-host";
import { AclConfigSchema, AuthConfigSchema } from "./auth-acl.schema";
import { GatewayConfigSchema } from "./gateway.schema";
import { EmbeddingsConfigSchema, IndexingConfigSchema } from "./indexing-embeddings.schema";
import {
  MaintenanceConfigSchema,
  ObservabilityConfigSchema,
  PlaneConfigSchema,
  PlurConfigSchema,
  SchedulerConfigSchema,
  SnapshotsConfigSchema,
  WatchConfigSchema,
} from "./observability.schema";
import { RerankerConfigSchema } from "./reranker.schema";
import {
  ExperientialConfigSchema,
  RankingConfigSchema,
  RetrievalConfigSchema,
} from "./retrieval.schema";
import {
  GovernorConfigSchema,
  SessionsConfigSchema,
  ThrottleConfigSchema,
  TransportsConfigSchema,
  WritesConfigSchema,
} from "./runtime.schema";
import {
  BootstrapConfigSchema,
  ToolFacadeConfigSchema,
  ToolVisibilityConfigSchema,
} from "./tools.schema";
import { VaultConfigSchema } from "./vault.schema";

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
  reranker: RerankerConfigSchema.optional().describe(
    "Reranker backend. ABSENT is meaningful: it preserves the historical behaviour of preferring the model-tier cross-encoder when configured, else the gateway passthrough, else a graceful no-op.",
  ),
  // THE-832: connection config for the inference gateway itself (extract/synthesize/judge/rerank).
  // ABSENT preserves today's behaviour exactly: falls through to OBSIDIAN_TC_GATEWAY_URL /
  // OBSIDIAN_TC_GATEWAY_TOKEN, then to every generative seam degrading gracefully.
  gateway: GatewayConfigSchema.optional().describe(
    "Inference gateway connection. ABSENT falls through to OBSIDIAN_TC_GATEWAY_URL / OBSIDIAN_TC_GATEWAY_TOKEN, preserving today's behaviour exactly.",
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
  sessions: SessionsConfigSchema.describe(
    "Whether the server opens workspace sessions itself, and how long one stays open.",
  ),
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
