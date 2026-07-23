import { z } from "zod";
import { isLoopbackHost } from "./net-host";

// Per-vault plugin-bridge timeouts (M4 / THE-180, G2.2 §3.1 + §6). Inner fields
// carry defaults; the whole block is optional so a vault that predates M4
// validates unchanged (consumers read `vault.bridges?.x ?? <default>`).
export const VaultBridgesConfigSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(5000)
    .describe("Timeout in ms for a general plugin-bridge call to this vault's Local REST API."),
  probeTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(500)
    .describe(
      "Timeout in ms for the startup plugin/liveness probe. Deliberately short: it runs before the server is useful, so a dead Obsidian must not stall boot.",
    ),
  ocrTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30000)
    .describe("Timeout in ms for an OCR bridge call, which is far slower than a normal request."),
  templaterTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30000)
    .describe(
      "Timeout in ms for a Templater bridge call, which may run arbitrary user template logic.",
    ),
});

// Per-vault probe overrides (M4 / THE-180, G2.2 §6). force_enabled/disabled treat
// a plugin as installed/missing regardless of the probe; probe_skip skips the
// startup probe entirely (force_enabled is then the source of truth) — the seam
// CI uses to assert tool behavior without a live Obsidian.
export const VaultPluginsConfigSchema = z.object({
  forceEnabled: z
    .array(z.string())
    .default([])
    .describe("Plugin ids to treat as installed and enabled regardless of what the probe finds."),
  forceDisabled: z
    .array(z.string())
    .default([])
    .describe("Plugin ids to treat as missing regardless of what the probe finds."),
  probeSkip: z
    .boolean()
    .default(false)
    .describe(
      "Skip the startup plugin probe entirely, making forceEnabled/forceDisabled the sole source of truth. The seam CI uses to assert tool behaviour without a live Obsidian.",
    ),
});

// Per-vault command-palette execution policy (M4 / THE-180, G2.1 Domain 26).
// Deny-by-default: execute_command is disabled unless `enabled` is explicitly true,
// and even then only ids in `allowlist` may be fired (and only with a HITL token —
// execute:command is a scope floor). Arbitrary command execution is never silent.
export const VaultCommandsConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "Allow execute_command on this vault at all. Deny-by-default: command execution stays off unless this is explicitly true.",
    ),
  allowlist: z
    .array(z.string())
    .default([])
    .describe(
      "Command ids that may be fired when enabled. Only ids listed here run, and only with a HITL token — there is no wildcard.",
    ),
});

// Per-vault memory-entity materialization config (M5 / THE-181, G2.1 Domain 22).
// Optional + back-compat: a vault predating M5 validates unchanged (consumers read
// `vault.memory?.folder ?? "memory"`). `folder` is where create_entity(materialize)
// writes the regenerable .md projection — a normal vault folder so the [[link]]
// graph resolves in Obsidian. SQLite stays the source of truth.
export const VaultMemoryConfigSchema = z.object({
  folder: z
    .string()
    .min(1)
    .default("memory")
    .describe(
      "Vault folder where create_entity(materialize) writes the regenerable .md projection. A normal folder so the [[link]] graph resolves in Obsidian; SQLite remains the source of truth.",
    ),
});

// Per-vault workspace-session trace config (M5 / THE-181, G2.1 Domain 23). Session
// traces are append-only JSONL written vault-relative (path-safe via resolveVaultPath
// + ACL-checked via enforcePathAcl) under this folder; default a dot-folder so they
// stay out of Obsidian's graph view. (G2.3 sketched cache_dir; THE-181's DoD requires
// ACL-checked, hence vault-relative.)
export const VaultWorkspaceConfigSchema = z.object({
  traceFolder: z
    .string()
    .min(1)
    .default(".obsidian-tc/traces")
    .describe(
      "Vault-relative folder for append-only JSONL session traces. Defaults to a dot-folder so traces stay out of Obsidian's graph view.",
    ),
});

export const VaultConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Stable identifier for this vault. Tools take it as their `vault` argument."),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Human-readable display name. Defaults to the id when absent."),
  path: z.string().min(1).describe("Absolute path to the vault directory on disk."),
  // THE-295: per-vault ACL override (same shape as the root `acl` block); absent -> the root
  // ACL is the inherited default. z.lazy defers the reference (AclConfigSchema is declared
  // below this schema).
  acl: z
    .lazy(() => AclConfigSchema)
    .optional()
    .describe(
      "Per-vault ACL override, same shape as the root `acl` block. Absent means the root ACL is inherited.",
    ),
  restApiUrl: z
    .string()
    .url()
    .optional()
    .describe("Base URL of this vault's Obsidian Local REST API, used for live-mode bridge calls."),
  restApiKey: z
    .string()
    .optional()
    .describe(
      "Bearer token for the Local REST API. Secret — never logged or echoed in a tool result.",
    ),
  // Headless mode selection (THE-255). Absent or `auto` probes the Local REST API once at
  // startup: reachable -> live (full surface), else headless (direct-atomic-fs vault state;
  // Tier-3 action tools degrade to requires_live_obsidian). `live`/`headless` force the mode
  // and skip the probe. Optional, so a config predating THE-255 validates unchanged;
  // resolveMode treats an absent mode as auto.
  mode: z
    .enum(["live", "headless", "auto"])
    .optional()
    .describe(
      "How this vault is reached. `auto` (the default when absent) probes the Local REST API once at startup: reachable means live, otherwise headless direct-filesystem access with Tier-3 action tools degrading to requires_live_obsidian. `live`/`headless` force the mode and skip the probe.",
    ),
  bridges: VaultBridgesConfigSchema.optional().describe(
    "Per-vault plugin-bridge timeouts. Absent uses the documented defaults.",
  ),
  plugins: VaultPluginsConfigSchema.optional().describe(
    "Per-vault plugin probe overrides, for forcing a plugin present/absent or skipping the probe.",
  ),
  commands: VaultCommandsConfigSchema.optional().describe(
    "Per-vault command-palette execution policy. Absent means command execution is disabled.",
  ),
  memory: VaultMemoryConfigSchema.optional().describe(
    "Per-vault memory-entity materialization settings.",
  ),
  workspace: VaultWorkspaceConfigSchema.optional().describe(
    "Per-vault workspace session-trace settings.",
  ),
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

export const AuthConfigSchema = z
  .object({
    mode: z
      .enum(["none", "jwt"])
      .default("none")
      .describe(
        "Authentication mode. `none` grants every request full wildcard scopes and is refused on a non-loopback HTTP bind; `jwt` requires a jwtSecret or a JWKS.",
      ),
    jwtSecret: z
      .string()
      .min(32)
      .optional()
      .describe(
        "Shared secret for HS256 verification, minimum 32 characters. Secret. HS256 tokens verify ONLY against this, never against the JWKS.",
      ),
    tokenTtlSeconds: z
      .number()
      .int()
      .positive()
      .default(86400)
      .describe(
        "Maximum accepted token AGE in seconds, measured from the token's `iat`. This caps age INDEPENDENTLY of `exp`: a token with a one-year expiry is still rejected once it is older than this, so a long-lived credential needs this raised to match.",
      ),
    // THE-297 — asymmetric verification (RS256/ES256/EdDSA) behind the TokenVerifier seam.
    // `jwks` is an inline JWKS document; `jwksFile` a path loaded once at transport boot (file
    // or inline only — no URL fetch: no new network attack surface). Key rotation = multiple
    // keys in the set, selected by the token's `kid` header (jose). HS256 stays available
    // beside it; alg-confusion is structurally impossible (HS256 verifies ONLY against
    // jwtSecret, asymmetric algs ONLY against the JWKS).
    jwks: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Inline JWKS document for asymmetric verification (RS256/ES256/EdDSA). Rotation is multiple keys in the set, selected by the token's `kid`.",
      ),
    jwksFile: z
      .string()
      .optional()
      .describe(
        "Path to a JWKS document, loaded once at transport boot. File or inline only — no URL fetch, so verification adds no network attack surface.",
      ),
    algorithms: z
      .array(z.string())
      .optional()
      .describe(
        "Explicit allowlist of accepted JWT algorithms. Algorithm confusion is structurally impossible regardless: HS256 verifies only against jwtSecret and asymmetric algorithms only against the JWKS.",
      ),
    // THE-456 — audience/issuer binding. When set, the JWT verifier enforces them (jose rejects a
    // token whose `aud`/`iss` does not match), closing the confused-deputy / token-passthrough gap
    // the MCP 2025-11-25 authorization spec requires of a protected resource. `audience` defaults to
    // the configured `resource` URI (below) when PRM is set, so a token an external AS minted for a
    // DIFFERENT service is rejected here. Both unset (and no PRM `resource`) keeps the current
    // behavior for local self-issued HS256 tokens.
    audience: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Expected `aud` claim. Binding it rejects a token an issuer minted for a DIFFERENT service (confused deputy). Required with a JWKS or a non-loopback bind; defaults to `resource` when Protected Resource Metadata is configured.",
      ),
    issuer: z
      .string()
      .optional()
      .describe(
        "Expected `iss` claim. Setting it also requires an audience — validating the issuer alone does not establish that the token was meant for this server.",
      ),
    // MCP 2025-11-25 / RFC 9728 Protected Resource Metadata (THE-278). All optional; the HS256 token
    // format is unchanged. When `resource` + at least one `authorizationServers` entry are set, the
    // HTTP transport advertises a spec-compliant PRM document + WWW-Authenticate challenge for the
    // OAuth 2.1 resource-server role. The authorization-server half (token issuance / DCR / OIDC)
    // stays out of scope until a real external AS exists.
    resource: z
      .string()
      .url()
      .optional()
      .describe(
        "This server's canonical resource URI (RFC 9728). Set together with authorizationServers to advertise Protected Resource Metadata; also serves as the default bound audience.",
      ),
    authorizationServers: z
      .array(z.string().url())
      .optional()
      .describe(
        "Authorization server issuer URLs advertised in the Protected Resource Metadata document. At least one is needed for PRM to be served.",
      ),
    resourceName: z
      .string()
      .optional()
      .describe(
        "Human-readable resource name published in the Protected Resource Metadata document.",
      ),
    scopesSupported: z
      .array(z.string())
      .optional()
      .describe("Scopes advertised as supported in the Protected Resource Metadata document."),
  })
  .refine((c) => c.mode !== "jwt" || !!c.jwtSecret || !!c.jwks || !!c.jwksFile, {
    message: "auth.mode 'jwt' requires jwtSecret (>=32 chars) or a JWKS (jwks / jwksFile)",
    path: ["jwtSecret"],
  });

export const AclRuleSchema = z.object({
  glob: z.string().min(1).describe("Glob matched against the vault-relative note path."),
  scopes: z
    .array(z.string())
    .default([])
    .describe(
      "Scopes granted to paths matching this rule. The LAST matching rule wins, replacing rather than merging the scopes of earlier matches.",
    ),
});

export const AclConfigSchema = z.object({
  readOnly: z
    .boolean()
    .default(false)
    .describe(
      "Reject every mutating operation on this vault regardless of the scopes a caller holds.",
    ),
  defaultScopes: z
    .array(z.string())
    .default([])
    .describe("Scopes granted to a path that matches no rule."),
  rules: z
    .array(AclRuleSchema)
    .default([])
    .describe("Ordered glob-to-scope rules. Later matches override earlier ones."),
  // Per-path operation ACL (G2.2 section 5 / G2.4). Optional and back-compatible:
  // when a field is omitted that operation kind is unrestricted (M0 behavior);
  // when present it is a glob whitelist — a path must match at least one entry.
  // camelCase mirrors the rest of the config (readOnly, defaultScopes).
  readPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Glob whitelist for reads: a path must match at least one entry. Omitted leaves reads unrestricted (see strictReadDefault).",
    ),
  writePaths: z
    .array(z.string())
    .optional()
    .describe(
      "Glob whitelist for writes: a path must match at least one entry. Omitted leaves writes unrestricted.",
    ),
  deletePaths: z
    .array(z.string())
    .optional()
    .describe(
      "Glob whitelist for deletes: a path must match at least one entry. Omitted leaves deletes unrestricted.",
    ),
  /** When true, an UNDEFINED readPaths whitelist fails CLOSED on the request path (read_note et
   *  al.), not just bridge enumeration (THE-268). Default false = M0 allow-all back-compat. */
  strictReadDefault: z
    .boolean()
    .default(false)
    .describe(
      "When true, an UNDEFINED readPaths whitelist fails CLOSED on the request path rather than only on bridge enumeration. Default false preserves allow-all back-compatibility.",
    ),
});

/** THE-397: retrieval-fusion knobs (the first config-exposed retrieval section). */
export const RetrievalConfigSchema = z.object({
  /** RRF constant for graph_rrf fusion. Keep BELOW the stream pool size (~30): larger k lets
   *  overlapping low-rank noise outrank confident single-stream hits (measured: 10 beats 60 on
   *  every metric at n=32; 20 is indistinguishable from 60). */
  rrfK: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Reciprocal-rank-fusion constant for graph_rrf. Keep BELOW the stream pool size (~30): a larger k lets overlapping low-rank noise outrank confident single-stream hits.",
    ),
  /** THE-258: the deterministic class router (temporal auto-stream, lexical short-circuit
   *  that skips the embedding round-trip; standard falls through unchanged). DARK by
   *  default — flips only after the per-class + aggregate A/B passes the ship rule. */
  classRouter: z
    .boolean()
    .default(false)
    .describe(
      "Enable the deterministic query-class router: a temporal auto-stream and a lexical short-circuit that skips the embedding round-trip. Ships dark pending an A/B on the golden set.",
    ),
  /** Serve-path bge-m3 learned-sparse RRF stream. When on AND the embeddings provider emits the
   *  multi-vector heads (embedFull: bge-m3 or model-tier), each query is also encoded to its sparse
   *  weights and fused as the "sparse" RRF stream. OFF by default - opt-in, measured on the golden
   *  set before shipping on (a no-op without a multi-vector provider). */
  sparse: z
    .boolean()
    .default(false)
    .describe(
      "Fuse a bge-m3 learned-sparse stream into RRF at serve time. A no-op unless the embeddings provider emits the multi-vector heads (bge-m3 or model-tier).",
    ),
  /** Serve-path bge-m3 ColBERT late-interaction rerank of the fused top-K. When on AND the provider
   *  emits the multi-vector heads, the query ColBERT matrix reranks the top-K by maxSim. OFF by
   *  default - opt-in, measured on the golden set (a no-op without a multi-vector provider). */
  colbert: z
    .boolean()
    .default(false)
    .describe(
      "Rerank the fused top-K by bge-m3 ColBERT late-interaction maxSim. A no-op unless the provider emits the multi-vector heads.",
    ),
  /** Graph densification (graphify spec-donor port): derived edges added to vault_edges beyond the
   *  literal wikilink layer, to reach multi-hop targets whose bridge notes are not explicitly linked.
   *  All OFF by default and measured on the multi-hop golden set before any flip — the THE-135
   *  frontier-leaf virtual-hop hit an 80% bridge-recall ceiling and the champion is already past it,
   *  so densification ships dark unless it wins. See docs/plans/2026-07-13-graph-densification.md. */
  densify: z
    .object({
      /** Emit shared-frontmatter-tag co-occurrence edges (edge_type shared_tag). */
      tagEdges: z
        .boolean()
        .default(false)
        .describe("Emit shared-frontmatter-tag co-occurrence edges (edge_type shared_tag)."),
      /** A tag on more than this many notes is a hub, not a signal — it emits no edges. */
      maxTagFanout: z
        .number()
        .int()
        .positive()
        .default(25)
        .describe(
          "A tag applied to more notes than this is treated as a hub rather than a signal and emits no edges.",
        ),
      /** Emit vec0 kNN semantic-neighbor edges (edge_type similar_to). Increment B. */
      knnEdges: z
        .boolean()
        .default(false)
        .describe("Emit vec0 kNN semantic-neighbour edges (edge_type similar_to)."),
      /** Neighbors per note for knnEdges. */
      knnK: z
        .number()
        .int()
        .positive()
        .default(8)
        .describe("Number of neighbours per note when knnEdges is enabled."),
      /** Drop knnEdges below this cosine similarity. 0 (default) keeps every neighbor the kNN returns.
       *  Exposed because the ablation tested a 0.80 floor that was not, until now, a selectable config. */
      knnMinSim: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
          "Drop kNN edges below this cosine similarity. 0 keeps every neighbour the kNN returns.",
        ),
      /** Let the graph walk traverse derived edges, down-weighted vs authored links. Increment C. */
      includeInWalk: z
        .boolean()
        .default(false)
        .describe(
          "Let the graph walk traverse derived edges, down-weighted against authored links.",
        ),
      /** Down-weight factor for expansion reached via a derived edge (annotate, not gate). */
      derivedWeight: z
        .number()
        .positive()
        .default(0.5)
        .describe(
          "Down-weight factor applied to expansion reached via a derived edge. Annotates the score rather than gating the edge.",
        ),
      /** Build LLM-inferred semantic edges (semantically_similar_to) via the local gateway.
       *  Batch-only (the densify-llm runner, not the inline index pass) — it sends note content to
       *  the model, local by default. OFF. */
      llmEdges: z
        .boolean()
        .default(false)
        .describe(
          "Build LLM-inferred semantic edges (semantically_similar_to) via the configured gateway. Batch-only, and it sends note content to the model — local by default.",
        ),
      /** Minimum discrete-rubric confidence to keep an LLM edge. */
      confidenceFloor: z
        .number()
        .min(0)
        .max(1)
        .default(0.55)
        .describe("Minimum discrete-rubric confidence required to keep an LLM-inferred edge."),
    })
    .prefault({})
    .describe(
      "Graph densification: derived edges added beyond the literal wikilink layer to reach multi-hop targets whose bridge notes are not explicitly linked. All off by default.",
    ),
  /** THE-391/THE-536: tilt the per-stream RRF weights by the query's lexical specificity — rare
   *  terms trust the BM25/sparse ranks, common-vocabulary queries trust the dense seeds. Neutral
   *  (static RRF) when disabled, when the specificity signal is unavailable, or at specificity
   *  0.5. Implemented and unit-tested (fusion.ts) and reachable from the eval harness
   *  (`--adaptive-rrf`) since THE-391, but had no config surface until now. OFF by default — no
   *  ranking change ships with this flag; it only makes an already-measured lever reachable. */
  adaptiveRrf: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe("Enable the adaptive per-stream RRF weighting tilt. Off by default."),
      gain: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Strength of the tilt, clamped to [0,1] so stream weights stay within [0,2] — an over-unity gain would drive a weight negative and invert its ranking rather than just reweight it.",
        ),
    })
    .prefault({})
    .describe(
      "Adaptive per-stream RRF weighting (THE-391): tilts dense vs lexical/sparse stream weight by per-query lexical specificity. Off by default.",
    ),
});

/** Metadata-prior (authority-boost) rule: add `boost` to the fused score of a result whose note
 *  frontmatter[field] === value. Ported from the retired KMS/vault-sync hardcoded prior
 *  (knowledge-mcp-server/migrations/009_vault_search_priority.sql, itself from
 *  vault-sync/sql/004_vault_search_priority.sql): additive boosts on top of the RRF hybrid score.
 *  `boost` may be negative (an archive-style penalty). */
export const MetadataPriorRuleSchema = z.object({
  field: z.string().min(1).describe("Frontmatter field name to test on a candidate note."),
  value: z.string().describe("Value that frontmatter[field] must equal for the boost to apply."),
  boost: z
    .number()
    .describe(
      "Amount added to the fused score on a match. May be negative, which makes the rule an archive-style penalty.",
    ),
});

/** Config-driven ranking overlays applied POST-FUSION in graph_search (tie-breaks, never overrides).
 *  All OFF by default and measured on the golden set before any flip. */
export const RankingConfigSchema = z.object({
  /** Frontmatter metadata prior (authority boost). When enabled, each result's fused score gains
   *  Σ(boost) over the rules whose note frontmatter[field]===value, then the list is re-sorted —
   *  composing ADDITIVELY with the expansion-stream decay. The total |Σboost| any single result can
   *  receive is clamped to `clampFraction` of the per-query fused-score spread, so the prior stays
   *  SUB-DOMINANT to the RRF signal (a tie-break, never an override — a low-RRF note cannot leapfrog
   *  a confident hit). OFF by default. */
  metadataPrior: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe("Apply the frontmatter authority-boost overlay after fusion."),
      rules: z
        .array(MetadataPriorRuleSchema)
        .default([])
        .describe("Field/value/boost rules summed for each result before the list is re-sorted."),
      /** Cap |Σboost| per result at this fraction of the observed fused-score spread (max−min over
       *  the per-query candidate pool). <1 guarantees sub-dominance: even a fully-boosted bottom
       *  result cannot overtake the top base-scored result. */
      clampFraction: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Cap the absolute total boost per result at this fraction of the observed fused-score spread. Below 1 this guarantees the prior stays a tie-break: a fully boosted bottom result still cannot overtake the top base-scored one.",
        ),
    })
    .prefault({})
    .describe("Frontmatter metadata prior (authority boost) applied post-fusion in graph_search."),
});

/** THE-230: experiential-tier (membrane store, experiential.db) knobs. */
export const ExperientialConfigSchema = z.object({
  /** Append serve-path retrieval events (chunk id + rank + score + query text + surface) to
   *  chunk_retrievals in experiential.db — local-only telemetry that feeds the ACT-R activation
   *  recompute and flywheel usage stats. Eval-harness runs call the search cores directly and
   *  never log (THE-187 eval/serve hygiene). false keeps the experiential handle closed after
   *  boot provisioning (pre-THE-230 behavior). */
  logRetrievals: z
    .boolean()
    .default(true)
    .describe(
      "Append serve-path retrieval events (chunk id, rank, score, query text, surface) to experiential.db. Local-only telemetry feeding activation recompute and usage stats; eval runs never log.",
    ),
  /** THE-228: capture every dispatch outcome as an agent_episodes row (action axis: tool,
   *  status, duration, sizes, hashes, attribution — no payloads). Local-only work-memory in
   *  experiential.db; the sleep-time evaluator stamps retrieval-eligibility. */
  captureEpisodes: z
    .boolean()
    .default(true)
    .describe(
      "Record every dispatch outcome as an agent_episodes row — tool, status, duration, sizes, hashes, attribution. No payloads are stored.",
    ),
  /** THE-228 content axis: also persist the raw parsed args (secret-scanned + size-capped)
   *  on each episode. Default OFF until the THE-238 poisoning defense lands — the write-on
   *  gate ordering. */
  captureContent: z
    .boolean()
    .default(false)
    .describe(
      "Also persist each episode's raw parsed arguments, secret-scanned and size-capped. Off until the poisoning defence lands: this is the write-side of the gate.",
    ),
  /** THE-187/193: builds and threads the cached_activation_score lookup (activationFor) to every
   *  M7 graphSearch call site. THE-535: as of THE-465/THE-447 this does NOT wire the ACT-R
   *  activation bubble pass (bubble_safe_rerank) into the serve path — that pass only fires when
   *  BOTH activationFor AND opts.bubbleSafe.enabled are set (graph_search_stages/projection.ts),
   *  and nothing under src/ ever sets bubbleSafe (only eval/run.ts and
   *  test/bubble-safe-wiring.test.ts do). So enabling this flag currently changes NO ranking —
   *  it only builds the lookup table the bubble pass would consume once wired. Wiring bubbleSafe
   *  into the serve path is a deliberate architectural step (it closes the
   *  chunk_retrievals -> recomputeActivation -> cached_activation_score -> ranking -> chunk_retrievals
   *  feedback loop and needs its own damping argument) left to THE-424. */
  activationRerank: z
    .boolean()
    .default(false)
    .describe(
      "Build the ACT-R cached-activation-score lookup and thread it to every M7 graphSearch call. NOT YET WIRED to the serve-path bubble pass (bubble_safe_rerank) — that requires opts.bubbleSafe.enabled, which nothing under src/ sets, so enabling this flag currently changes no ranking. See THE-424 for the (deliberately deferred) wiring decision.",
    ),
});

export const EmbeddingsConfigSchema = z.object({
  provider: z
    .enum(["ollama", "openai", "voyage", "cohere", "bge-m3", "model-tier"])
    .default("ollama")
    .describe(
      "Embeddings backend. `model-tier` splits dense and multi-vector across two services.",
    ),
  model: z
    .string()
    .default("nomic-embed-text")
    .describe("Embedding model name as the provider names it."),
  dimensions: z
    .number()
    .int()
    .positive()
    .default(768)
    .describe(
      "Stored vector width, and the width of the vec0 column. Changing it requires a fresh index — existing vectors are not re-projected.",
    ),
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Provider base URL. Required for self-hosted runners; hosted providers default to their public API.",
    ),
  apiKey: z
    .string()
    .optional()
    .describe("Provider API key. Secret — never logged or returned by a tool."),
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
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(120000)
    .describe(
      "Timeout in ms for a single embed request. Defaults high because local runners are far slower than hosted APIs.",
    ),
  batchSize: z.number().int().positive().default(512).describe("Maximum inputs per embed request."),
  maxBatchTokens: z
    .number()
    .int()
    .positive()
    .default(2048)
    .describe(
      "Estimated-token ceiling per request (chars/4), splitting a dense sub-batch before it overruns a local runner's budget. Must stay UNDER the provider's loaded context: Ollama defaults to n_ctx 4096 and rejects an over-budget request, and the chars/4 estimate undercounts real tokenization on link-dense markdown.",
    ),
  concurrency: z
    .number()
    .int()
    .positive()
    .default(4)
    .describe("How many embed requests run in flight at once."),
  // THE-387: Matryoshka (MRL) dimension truncation. When true, a provider that returns vectors
  // WIDER than `dimensions` is truncated to the first `dimensions` components + renormalised (so a
  // wide MRL model such as Qwen3-8B at 4096 can be stored at 1024). Off by default; a non-MRL width
  // mismatch still errors rather than silently truncating meaningless prefixes.
  truncate: z
    .boolean()
    .default(false)
    .describe(
      "Matryoshka (MRL) truncation: accept a provider vector WIDER than `dimensions` by keeping the first `dimensions` components and renormalising. Off by default so a non-MRL width mismatch errors instead of silently storing a meaningless prefix.",
    ),
  /** THE-406: contextual chunk enrichment. When true, each chunk is embedded and BM25-indexed as
   *  "{note title}{ — heading breadcrumb}\n\n{content}" instead of the bare section text — the
   *  chunker strips heading lines into metadata, so title/heading-only evidence is otherwise
   *  invisible to both retrieval streams. Display content (chunks.content) stays raw. The chunk
   *  content hash covers the enriched text, so flipping this re-embeds the vault on the next
   *  reconcile. DEFAULT ON since THE-408: measured +0.223 nDCG@10 (p=0.0001) with the divergence
   *  rebuild now enrichment-aware. UPGRADE NOTE: an index built with the flag off re-embeds in
   *  full on the first reconcile after upgrading (hash change) — set `chunkContext: false` to
   *  keep the old representation. */
  chunkContext: z
    .boolean()
    .default(true)
    .describe(
      'Embed and BM25-index each chunk as "{title}{ — heading breadcrumb}\\n\\n{content}" rather than bare section text, so title- and heading-only evidence is visible to both retrieval streams. Displayed content stays raw. The chunk hash covers the enriched text, so changing this re-embeds the vault on the next reconcile.',
    ),
  /** THE-405: asymmetric instruct prefixes for models whose cards require them (e.g.
   *  Qwen3-Embedding's "Instruct: ...\nQuery: " on the query side, documents plain). Applied at
   *  the provider factory: `queryPrefix` on embeds marked input:"query", `documentPrefix` on
   *  everything else (indexing). BOTH default empty — nomic-style prefixes measured HARMFUL on
   *  this vault (2026-07-11), so nothing changes unless a config opts in. Changing
   *  `documentPrefix` re-embeds nothing by itself (hashes cover chunk text, not the prefix) —
   *  pair a document-prefix change with a fresh cacheDir. */
  queryPrefix: z
    .string()
    .default("")
    .describe(
      "Instruct prefix prepended to query-side embeds, for models whose cards require one. Empty by default — such prefixes measured harmful on this corpus.",
    ),
  documentPrefix: z
    .string()
    .default("")
    .describe(
      "Instruct prefix prepended to document-side (indexing) embeds. Empty by default. Changing it re-embeds nothing on its own, since hashes cover chunk text and not the prefix — pair a change with a fresh cacheDir.",
    ),
  /** #237: polyglot model tier - dense retrieval from Qwen3 via the Rust TEI service,
   *  sparse+ColBERT from BGE-M3 via the Python service (services/bge-m3-service). Required when
   *  provider is "model-tier". The two are SEPARATE streams fused by RRF on ranks;
   *  embeddings.dimensions is the Qwen dense width (the vec0 column). */
  modelTier: z
    .object({
      dense: z
        .object({
          baseUrl: z
            .string()
            .url()
            .describe("Base URL of the dense (Qwen3 via Rust TEI) embedding service."),
          model: z
            .string()
            .default("Qwen/Qwen3-Embedding-0.6B")
            .describe("Dense model id. Its width is what embeddings.dimensions must match."),
          revision: z.string().optional().describe("Pinned model revision for the dense service."),
          pooling: z
            .string()
            .default("last-token")
            .describe("Pooling strategy for the dense model."),
        })
        .describe("Dense retrieval half of the model tier. Required when provider is model-tier."),
      full: z
        .object({
          baseUrl: z.string().url().describe("Base URL of the multi-vector (BGE-M3) service."),
          model: z.string().default("BAAI/bge-m3").describe("Multi-vector model id."),
          revision: z
            .string()
            .optional()
            .describe("Pinned model revision for the multi-vector service."),
          authToken: z
            .string()
            .optional()
            .describe("Bearer token for the multi-vector service. Secret."),
          dimensions: z
            .number()
            .int()
            .positive()
            .default(1024)
            .describe(
              "Dense width of the multi-vector model, separate from embeddings.dimensions.",
            ),
        })
        .optional()
        .describe(
          "Sparse and ColBERT half of the model tier. Absent disables the retrieval.sparse and retrieval.colbert streams.",
        ),
    })
    .optional()
    .describe(
      "Polyglot model tier: dense retrieval from one service and sparse/ColBERT from another, fused by RRF on ranks. Required when provider is model-tier.",
    ),
});

// THE-458 (audit #5): index-on-write coordinator concurrency + backpressure. Fully defaulted so a
// config predating it validates unchanged. `writeConcurrency` bounds concurrent index/embed calls
// across ALL vaults; `writeConcurrencyPerVault` bounds them per vault (audit recommends 2–4);
// `queueMax` is a soft distinct-pending-path cap that surfaces backpressure in server_health (writes
// are never dropped).
export const IndexingConfigSchema = z
  .object({
    writeConcurrency: z
      .number()
      .int()
      .positive()
      .default(8)
      .describe("Ceiling on concurrent index/embed calls across ALL vaults."),
    writeConcurrencyPerVault: z
      .number()
      .int()
      .positive()
      .default(4)
      .describe("Ceiling on concurrent index/embed calls for a single vault."),
    queueMax: z
      .number()
      .int()
      .positive()
      .default(1000)
      .describe(
        "Soft cap on distinct pending paths, surfaced as backpressure in server_health. Writes are never dropped when it is exceeded.",
      ),
  })
  .prefault({});
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;

export const HttpConfigSchema = z.object({
  enabled: z.boolean().default(false).describe("Serve the MCP HTTP transport."),
  host: z
    .string()
    .default("127.0.0.1")
    .describe(
      "Bind address. A non-loopback host is refused while auth.mode is `none`, since every request would otherwise resolve to full wildcard scopes.",
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8765)
    .describe("TCP port for the HTTP transport."),
  // DNS-rebinding / cross-origin protection (THE-271). On by default: reject a request whose Host is
  // neither loopback nor operator-allowed, or whose Origin (browsers always send one) is not the same
  // origin or operator-allowed. Server-to-server clients send no Origin and are unaffected.
  enableDnsRebindingProtection: z
    .boolean()
    .default(true)
    .describe(
      "Reject a request whose Host is neither loopback nor operator-allowed, or whose Origin is neither same-origin nor operator-allowed. Server-to-server clients send no Origin and are unaffected.",
    ),
  allowedHosts: z
    .array(z.string())
    .default([])
    .describe("Additional Host header values accepted by the rebinding guard."),
  allowedOrigins: z
    .array(z.string())
    .default([])
    .describe("Additional Origin header values accepted by the rebinding guard."),
});

export const TransportsConfigSchema = z.object({
  stdio: z.boolean().default(true).describe("Serve the MCP stdio transport."),
  http: HttpConfigSchema.prefault({}).describe("HTTP transport settings."),
});

export const GovernorConfigSchema = z.object({
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .default(1_000_000)
    .describe("Ceiling on a single tool response in bytes, before it is truncated or refused."),
  // THE-293: worker-time budget (ms) for one search_regex / search_vault(mode:regex) call.
  // Only regex execution in the worker counts — file I/O does not — so a benign pattern on a
  // large vault cannot false-positive the ReDoS guard.
  regexTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(2000)
    .describe(
      "Worker-time budget in ms for one regex search. Only regex execution counts — file I/O does not — so a benign pattern over a large vault cannot false-positive the ReDoS guard.",
    ),
});

// Per-scope-class throttle tiers + write-concurrency ceiling (THE-182 / M6, G2.4
// §Rate limits). Additive + fully defaulted, so a config predating M6 validates
// unchanged. The M6 bulk tools enforce the `bulk` tier (10/min, burst 3); the
// other tiers are reported by get_server_config and reserved for the M7
// dispatch-wide rate-limit gate. get_server_config surfaces these as its `limits`
// block (non-secret).
const throttleTier = (kind: string, perMinute: number, burst: number) =>
  z
    .object({
      perMinute: z
        .number()
        .int()
        .positive()
        .default(perMinute)
        .describe(`Sustained ${kind}-scope calls allowed per minute.`),
      burst: z
        .number()
        .int()
        .positive()
        .default(burst)
        .describe(
          `Bucket depth for ${kind}-scope calls: how many may fire back-to-back before the per-minute rate applies.`,
        ),
    })
    .prefault({})
    .describe(`Throttle tier for ${kind}-scope tools.`);

export const ThrottleConfigSchema = z
  .object({
    enabled: z.boolean().default(true).describe("Enforce per-scope-class rate limits."),
    tiers: z
      .object({
        read: throttleTier("read", 600, 100),
        write: throttleTier("write", 60, 20),
        delete: throttleTier("delete", 60, 20),
        bulk: throttleTier("bulk", 10, 3),
        execute: throttleTier("execute", 5, 1),
        admin: throttleTier("admin", 5, 1),
      })
      .prefault({})
      .describe("Per-scope-class rate limits."),
    maxConcurrentWritesPerVault: z
      .number()
      .int()
      .positive()
      .default(16)
      .describe("Ceiling on concurrent write operations against a single vault."),
  })
  .prefault({});
export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;

// THE-252: write-safety policy. requireCas gates compare-and-swap on the destructive write paths.
export const WritesConfigSchema = z
  .object({
    // When true, write_note (overwrite) and append_note to an existing note REQUIRE a prev_hash
    // (compare-and-swap) and fail closed with invalid_input when it is absent, so a stale or absent
    // hash cannot silently clobber. Default off; the non-configurable hard default is deferred to a major.
    requireCas: z
      .boolean()
      .default(false)
      .describe(
        "Require a prev_hash (compare-and-swap) on overwriting writes and on appends to an existing note, failing closed with invalid_input when absent so a stale hash cannot silently clobber.",
      ),
  })
  .prefault({});
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
      // morgianaEventsDays / tracesDays were declared and read by nothing: the maintenance sweep prunes
      // event_log and nothing else, so morgiana spools and trace files grow without bound whatever these
      // were set to. Removed rather than left implying a retention policy that does not exist.
      eventLogDays: z
        .number()
        .int()
        .positive()
        .default(30)
        .describe(
          "Days of event_log rows kept by the maintenance sweep. This is the ONLY retention that is enforced: trace files and the event spool are not pruned and grow without bound.",
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
      .default(false)
      .describe(
        "Capture the prior content-addressed state before a destructive note write, so restore_note can roll back.",
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
// tool surface (back-compat); "domain" advertises ~a dozen domain meta-tools (THE-275). Every registered
// tool stays callable by name regardless of mode, so nothing is removed.
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
    const hasJwks = Boolean(cfg.auth.jwks || cfg.auth.jwksFile);
    const boundAudience = cfg.auth.audience ?? cfg.auth.resource;
    const remote = http.enabled && !isLoopbackHost(http.host);
    if (hasJwks && boundAudience === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "audience"],
        message:
          "auth.mode 'jwt' with a JWKS (jwks/jwksFile) requires auth.audience (or auth.resource): a JWKS trusts an external issuer, so without an audience a token that issuer minted for another service is accepted here (confused deputy). (THE-456)",
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
