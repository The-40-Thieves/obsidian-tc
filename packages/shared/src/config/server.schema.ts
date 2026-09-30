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
  EgressConfigSchema,
  MaintenanceConfigSchema,
  ObservabilityConfigSchema,
  PensieveConfigSchema,
  PlaneConfigSchema,
  PlurConfigSchema,
  ReadwiseConfigSchema,
  SchedulerConfigSchema,
  SnapshotsConfigSchema,
  TelemetryConfigSchema,
  WatchConfigSchema,
} from "./observability.schema";
import { PersonasConfigSchema } from "./personas.schema";
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
      "Named security posture applied before validation. 'hardened' sets the least-privilege defaults (strictReadDefault, requireCas, snapshots on, HTTP off, auth.requireJti on); explicit fields override it. 'trusted-local' (the default) keeps the permissive single-user posture.",
    ),
  cacheDir: z
    .string()
    .default(".obsidian-tc")
    .describe(
      'Directory holding the derived index and caches. `cache.db`, `experiential.db` and the other index files are regenerable — deleting them forces a full reindex — EXCEPT `auth.db` and `auth-keys/`, the auth registry: revocations, key retirements and signing-key files that CANNOT be regenerated and must be backed up (delete only `cache.db*`, never the whole directory, when resetting the index). This default only applies when `embeddings.provider` is not "local" — a config file must set `cacheDir` explicitly when the embeddings provider is "local" (the default provider), or config load fails naming `cacheDir`; the bare `obsidian-tc <vault>` form (no config file) sets it for you.',
    ),
  // THE-935 (GH #878): the first config surface over db/pragmas.ts — no `db` block existed before
  // this, so it is introduced here, beside cacheDir, rather than nested under it.
  db: z
    .object({
      busyTimeoutMs: z
        .number()
        .int()
        .min(1)
        .default(5000)
        .describe(
          "Milliseconds SQLite's busy handler retries a write before giving up, applied FIRST on every connection so it covers even the WAL-conversion window. Raising it is SYMPTOM TREATMENT, not a fix: a rising obsidian_tc_sql_lock_wait_seconds tail past this value is the direct evidence the writers genuinely overlap that long, and the fix is splitting the shared database per vault, not raising this further. Easy to miss: stdio MCP spawns ONE SERVER PROCESS PER CLIENT, and every process opens the SAME cache.db, so the concurrent client count is load-bearing for how much contention this has to absorb — one operator measured `server_health` degraded (write_failures, last_write_error 'timed out') at 17 concurrent stdio processes on one cache.db, and ok again at 5 (GH #878).",
        ),
    })
    .prefault({})
    .describe(
      "SQLite connection tuning, applied on every cache.db, experiential.db and ratelimit.db open.",
    ),
  vaults: z
    .array(VaultConfigSchema)
    .min(1)
    .describe("Vaults this server serves. At least one is required."),
  plur: PlurConfigSchema.optional().describe(
    "plur engram-store read proxy. Global rather than per-vault, since the plur store is global.",
  ),
  // THE-650: Readwise adapter config for `obsidian-tc import-highlights`. Global rather than
  // per-vault, matching `plur` just above — the Readwise account is one external source, and
  // which vault its highlights land in is chosen per invocation (--vault), not per config block.
  readwise: ReadwiseConfigSchema.optional().describe(
    "Readwise highlight-import adapter. ABSENT (no token) means `import-highlights` no-ops with NO network call.",
  ),
  // THE-175: Pensieve ambient-capture adapter config for `obsidian-tc import-ambient`. Global
  // rather than per-vault, matching `readwise`/`plur` above — which vault an observation lands in
  // is chosen per invocation (--vault), and which machine's Pensieve instance to poll is
  // per-invocation too (--machine), so this block is just the one connection detail (baseUrl).
  pensieve: PensieveConfigSchema.optional().describe(
    "Pensieve ambient-capture adapter. ABSENT (no baseUrl) means `import-ambient` no-ops with NO network call.",
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
    "Reranker backend. ABSENT is meaningful: it preserves the historical behaviour of preferring the model-tier cross-encoder when configured, else the gateway passthrough, else the bundled offline 'local' cross-encoder IF the optional @the-40-thieves/obsidian-tc-reranker-local package happens to resolve on this deployment and no gateway URL is configured; else a graceful RRF-only no-op, unchanged from before that fallback existed.",
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
  // THE-647 item 2: named scope+vault+visibility bundles a JWT `persona` claim resolves to.
  // Absent (the default) means no persona claim can ever resolve — see auth/persona.ts, which
  // fails closed rather than falling back to the token's own (wider) scopes.
  personas: PersonasConfigSchema.optional().describe(
    "Named persona bundles ({vaults, scopes, toolVisibility?}) a JWT's `persona` claim resolves to. Absent means no personas are configured — any token carrying a `persona` claim is refused.",
  ),
  // show_file_in_obsidian's OS-handler fallback. Inline rather than a leaf export: the facade's
  // export surface is pinned (check:facade-parity), and nothing outside this object reads it.
  uri: z
    .object({
      allowOsLaunch: z
        .boolean()
        .default(false)
        .describe(
          "Let `show_file_in_obsidian` hand an obsidian:// URI to this machine's OS URI handler (xdg-open, open, rundll32) when no live Obsidian session answers through the companion plugin. Off by default and honoured ONLY for the local stdio transport: over HTTP the tool refuses regardless of this flag, because the launch happens on the server host, not the caller's machine. The URI is always built from a vault-relative path that passed the read ACL; no caller-supplied URI is ever launched.",
        ),
    })
    .prefault({})
    .describe("Host-side URI launching."),
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
  egress: EgressConfigSchema.describe(
    "Paths withheld from the inference gateway and the embedding provider — a different question from auth.acl.readPaths, which governs read visibility.",
  ),
  sessions: SessionsConfigSchema.describe(
    "Whether the server opens workspace sessions itself, and how long one stays open.",
  ),
  // THE-1125: opt-in, anonymous, off-by-default usage telemetry. See TelemetryConfigSchema's own
  // comment (observability.schema.ts) for the full contract — enabled requires endpoint (refused
  // below the object level, in TelemetryConfigSchema's own superRefine, since both fields it reads
  // are its own).
  telemetry: TelemetryConfigSchema.describe(
    "Opt-in, anonymous usage telemetry. Off by default, no default endpoint — see docs/configuration/telemetry.md.",
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
  // PR B of GH #995's two-part follow-up (PR A: #1001, `obsidian-tc setup`): set ONLY by `serve`'s
  // own first-run fallback (cli/setup/first-run-fallback.ts) when it auto-wrote this exact file
  // because no config existed and exactly one vault was found — never set by an interactive
  // `obsidian-tc setup` run, and never re-derived at boot. `doctor` reads it to tell an operator
  // the config was auto-generated (not hand-reviewed) and point them at `obsidian-tc setup` to
  // review or change it.
  setupOrigin: z
    .enum(["first-run-fallback"])
    .optional()
    .describe(
      "Set only by `obsidian-tc serve`'s own first-run fallback when it auto-wrote this config (exactly one vault found, no ambiguity) — never set by an interactive `obsidian-tc setup` run. `doctor` surfaces this so an auto-generated config is visibly distinct from a reviewed one.",
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
  // `oidc` mode: the trust anchor is the `auth.oidc` block and nothing else. An `oidc` block under
  // any other mode would LOOK like protection while none applies (mode none admits everyone), so it
  // is refused; and jwt-mode key/issuer keys beside an oidc block would leave two answers to "who
  // issues tokens here", so they are refused too. `jwtSecret` is allowed (it also keys the HITL
  // elicit codec) but never verifies an oidc bearer.
  if (cfg.auth.mode === "oidc") {
    const a = cfg.auth;
    if (a.oidc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "oidc"],
        message:
          "auth.mode is 'oidc' but auth.oidc is not set: configure at least auth.oidc.issuer and auth.oidc.audience.",
      });
    }
    const conflicting = (
      [
        ["jwks", a.jwks],
        ["jwksFile", a.jwksFile],
        ["jwksUri", a.jwksUri],
        ["algorithms", a.algorithms],
        ["issuer", a.issuer],
        ["audience", a.audience],
      ] as const
    )
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    for (const key of conflicting) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", key],
        message: `auth.${key} is a jwt-mode setting and is ignored under auth.mode 'oidc': set the equivalent under auth.oidc instead (auth.oidc.${key === "algorithms" ? "allowedAlgs" : key}).`,
      });
    }
    if (
      a.oidc !== undefined &&
      a.authorizationServers !== undefined &&
      (a.authorizationServers.length !== 1 || a.authorizationServers[0] !== a.oidc.issuer)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "authorizationServers"],
        message:
          "under auth.mode 'oidc' the advertised authorization server is auth.oidc.issuer; auth.authorizationServers must be omitted or contain exactly that issuer.",
      });
    }
  } else if (cfg.auth.oidc !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["auth", "oidc"],
      message: `auth.oidc is set but auth.mode is "${cfg.auth.mode}": nothing would verify tokens against it. Set auth.mode to "oidc", or remove auth.oidc.`,
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
