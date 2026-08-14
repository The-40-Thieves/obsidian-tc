import type { Tracer } from "@opentelemetry/api";
import type {
  MorgianaEventData,
  MorgianaEventType,
  ToolVisibilityConfig,
  VaultKind,
} from "@the-40-thieves/obsidian-tc-shared";
import type { z } from "zod";
import type { FolderAcl } from "../../acl";
import type { Database } from "../../db/types";
import type { ElicitRequestState } from "../../elicit-request-state";
import type { MetricsRecorder } from "../../metrics/registry";
import type { TraceCarrier } from "../../otel/propagation";
import type { RateLimiter } from "../../throttle";
import type { AclOp } from "../../vault/acl-path";
import type { TraceRecord } from "../../workspace/sessions";
import type { ClientInfo } from "../client-info";

// WP4.1: this file holds registry.ts's public types and pure declarations — no behaviour, no
// dispatch logic. registry.ts re-exports the ones that were already public (see its own imports)
// so every existing consumer of the facade keeps working unchanged (check:facade-parity pins this).

/** #13: the idempotency claim's lifecycle states, as a union so `row.state === "..."`
 *  comparisons in dispatch are compiler-checked against typos. The DB column itself is a plain
 *  string; readIdempotency casts it to this type at the read site. */
export type IdempotencyState = "in_flight" | "effect_committed" | "completed" | "indeterminate";

export interface CallerContext {
  caller: string | null;
  authenticated: boolean;
  grantedScopes: Set<string>;
  vaultId: string;
  /** When true, the caller is bound to `vaultId` (HTTP tokens): a tool call whose `vault`
   *  argument names a different vault is rejected (THE-267), mirroring the resources/read guard.
   *  The trusted stdio context leaves this unset so the local operator addresses every vault. */
  vaultBound?: boolean;
  db: Database;
  elicitToken?: string | null;
  /** THE-583: a transport-VERIFIED 2026-era HITL confirmation (HMAC+TTL already checked); the
   *  gate still binds it to this call. Absent for 2025 callers, who use `elicitToken`. */
  elicitState?: ElicitRequestState;
  acl?: FolderAcl;
  /**
   * SEP-2577 client features. Deprecated by the 2026-07-28 revision but functional for at least a
   * twelve-month window, so a client mid-migration still uses them.
   *
   * Surfaced HERE, on the context every tool receives, rather than consumed by any tool we happen to
   * ship. This is a public server: the useful thing is that a downstream tool author can reach the
   * calling client's roots and model at all. Both are `undefined` when the client did not advertise
   * the capability — an absent optional feature is a normal state, not an error.
   *
   * `roots` is ADVISORY. Vaults come from config; a client naming a root does not grant access to
   * it, which is exactly what makes consuming it safe.
   */
  roots?: () => Promise<Array<{ uri: string; name?: string }> | undefined>;
  /** Ask the CLIENT's model for a completion. Undefined unless the client advertised `sampling`. */
  sample?: (params: {
    messages: unknown[];
    maxTokens: number;
    systemPrompt?: string;
  }) => Promise<unknown | undefined>;
  /** THE-209: active workspace session for this caller. When set (by the transport context
   *  factory), each dispatch appends a tool_invocation record to that session's JSONL trace. */
  sessionId?: string;
  /** THE-572: a multi-step handler's mid-execution "my first durable effect is about to land"
   *  signal. #13 sets the `effect_committed` marker only when the WHOLE handler returns, so a
   *  handler that commits effect #1 and then does more fallible work leaves a real window: a
   *  throw before the return deletes the claim and a retry double-applies. Calling this
   *  IMMEDIATELY BEFORE the first durable effect moves the marker to the true first-effect
   *  point, so any later fault resolves to a durable `indeterminate_outcome` instead of a
   *  re-run. Write-ahead on purpose: marking before the effect can only over-report
   *  (a caller told to verify state when nothing applied), never under-report (a silent
   *  double-apply). Where the first effect is itself a write on `ctx.db`, call this INSIDE
   *  the same transaction as that write so a rolled-back effect leaves the claim legitimately
   *  re-runnable and the over-report does not happen at all.
   *
   *  Idempotent, and absent (undefined) when the call carries no idempotency key — always
   *  invoke as `ctx.markEffectCommitted?.()`. */
  markEffectCommitted?: () => void;
  now?: () => number;
  /** THE-514: the transport's per-request AbortSignal (MCP SDK `extra.signal`, an HTTP request's
   *  abort, or a stdio caller's own cancellation), threaded in by the context factory. runDispatch
   *  checks it at a few stage boundaries and immediately before the handler runs, so a cancelled
   *  call stops promptly instead of running a handler nobody is waiting on. Absent for any caller
   *  that does not supply one (every existing caller today) — every check is then a no-op, so
   *  behavior is unchanged. Deliberately NOT observed by tool handlers in this change: honoring it
   *  mid-handler is a per-tool behavior change left to a follow-up. */
  signal?: AbortSignal;
  /** SEP-414: W3C trace context lifted from the request's MCP `_meta`, set by the transport's
   *  request handler. When present, dispatch's SERVER span is parented to the CALLER's span, so a
   *  trace that starts in a host application continues through this server instead of ending at the
   *  edge and starting a second, unrelated tree. Absent for any caller that sends none — the span
   *  is then a root exactly as before. */
  traceCarrier?: TraceCarrier;
  /** THE-627: which client software made this call, lifted from the request's MCP `_meta`. Absent
   *  for every caller that sends none — which is all of them under the current spec, so absent is
   *  the normal value. Consumed by start_session to stamp the session row. */
  clientInfo?: ClientInfo;
}

/** MCP 2025-11-25 icon metadata (a structural subset of the SDK's Icon), surfaced in tools/list +
 *  describe_capability (THE-278). Optional plumbing; no tool populates it yet. */
export interface ToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

/** THE-513: the facade's domain-grouping ids — a closed set of 13, unchanged since the THE-577
 *  backfill made the (now-removed) facade domain map complete. Declared here, not in mcp/facade.ts,
 *  so `ToolDefinition.domain` can require one: domain membership is a fact about the capability
 *  itself, not a second hand-maintained catalog naming ~150 tools by string. mcp/facade.ts groups
 *  the caller-visible surface by this field; it no longer carries membership of its own. */
export const TOOL_DOMAINS = [
  "notes",
  "metadata",
  "links",
  "search",
  "vault",
  "attachments",
  "structured",
  "workspace",
  "automation",
  "git",
  "knowledge",
  "docs",
  "admin",
] as const;

export type ToolDomain = (typeof TOOL_DOMAINS)[number];

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  /** THE-583: runnable as a background TASK on `params.task`; opt-in. See mcp/tasks.ts. */
  taskAugmentable?: boolean;
  /** THE-513: which facade domain (see TOOL_DOMAINS) this capability groups under in "domain" mode.
   *  Optional here (the sink type) so fixtures unrelated to the facade — dispatch/throttle/HITL
   *  unit tests build bare ToolDefinition literals to exercise the pipeline — don't need to fabricate
   *  one; `domainTools()` falls back to "other" for a tool with none. It is REQUIRED on `ToolSpec`
   *  (m1/define.ts), which is what every real definition goes through, so a production tool cannot
   *  ship without one — the failure mode that let the old hand-kept facade map fall 38 tools behind
   *  in THE-577 is now a type error at the definition site, not a silent "other" bucket. */
  domain?: ToolDomain;
  /** THE-513 Part 2: the input field name that carries this tool's target vault id, when it has
   *  one — default "vault", the name every tool used before this field existed. The four
   *  `vaultArgOf` call sites below (vault-binding, per-vault ACL swap, vault-kind gate, central
   *  pathAcl) read THIS instead of hardcoding "vault", so a tool naming the field anything else
   *  is still bound/ACL-swapped/gated correctly. Before this field, a capability naming its vault
   *  argument anything other than "vault" silently escaped all four of those checks — they simply
   *  saw `undefined` and skipped. Optional here (the sink type, same reasoning as `domain`); every
   *  MUTATING tool whose schema has a vault-shaped field MUST declare it via `vault-arg-coverage
   *  .test.ts`, mirroring `acl-extraction-coverage.test.ts`'s mutating derivation. */
  vaultArg?: string;
  /** THE-513 Part 2: declares that this tool's input schema exposes a whole-operation idempotency
   *  key recognized by `extractIdempotencyKey` (top-level `idempotency_key` / `bulk_idempotency_key`,
   *  or nested `options.idempotency_key`) — never a per-item `items[].idempotency_key`. Before this
   *  field, extractIdempotencyKey sniffed the input shape at runtime for every one of the ~150
   *  tools and nothing declared which ones actually accept a key, so a capability that SHOULD be
   *  idempotent and isn't (or vice versa) went unnoticed. `idempotency-declaration-coverage.test.ts`
   *  cross-checks this against the schema in both directions: declared-but-schema-silent and
   *  schema-exposes-a-key-but-undeclared both fail. */
  acceptsIdempotencyKey?: boolean;
  /** THE-743: the MCP spec's `ToolAnnotations.idempotentHint` — "calling the tool repeatedly with
   *  the same arguments will have no additional effect on its environment", default false,
   *  meaningful ONLY when `readOnlyHint == false`. Advisory metadata; dispatch authorizes on
   *  `requiredScopes` / `destructive` and MUST NOT start enforcing on this.
   *
   *  DELIBERATELY NOT DERIVED FROM `acceptsIdempotencyKey` ABOVE. Those are different claims and
   *  conflating them would advertise something false: accepting a key means a retry is safe WHEN
   *  THE CALLER SUPPLIES ONE, and the key is optional — a repeat without it still has an effect.
   *  `idempotentHint` is unconditional, about the arguments alone.
   *
   *  NO TOOL DECLARES THIS TODAY, and that is a finding rather than an omission. Every mutating
   *  call on this server leaves a durable record by construction: `forget_log` is an append-only
   *  hash-chained audit (one INSERT per call), and destructive note writes capture a snapshot for
   *  `restore_note` (THE-648, on by default under `trusted-local`). A second identical call
   *  therefore appends a second audit row or a second snapshot version — an additional effect on
   *  the environment, which is exactly what the hint denies. So `false` is the honest value for all
   *  60 mutating tools, and it is also the spec default; the value of declaring the field is that
   *  the next tool to be genuinely idempotent has somewhere to say so, and a gate that checks it. */
  idempotent?: boolean;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Optional output schema (MUST be a Zod OBJECT) advertised as the tool's `outputSchema`
   *  (MCP 2025-11-25, THE-278). When set, conformant clients REQUIRE + validate structuredContent
   *  on a successful result, so the handler's success payload MUST always be an object matching it.
   *  Opt-in per tool; the server already emits structuredContent for object results. */
  outputSchema?: z.ZodType<O>;
  requiredScopes: string[];
  /** Free-form classification labels for tool-visibility scoping (THE-219):
   *  matched against toolVisibility.hiddenTags / disabledTags. */
  tags?: string[];
  /** Optional MCP 2025-11-25 icons metadata (THE-278). Boundary-only; never read by dispatch. */
  icons?: ToolIcon[];
  destructive?: boolean;
  /** THE-824: this tool calls `requireConfirmation` — it demands its elicit token
   *  CONDITIONALLY (crossing a folder boundary, an overwrite, a bulk-cost floor, ...), decided at
   *  runtime by the handler, so `destructive` above (which also drives the dispatch-time
   *  isMutatingCall/hitlRequired gates via policy-gates.ts) MUST stay unset/false for it — setting
   *  it would make dispatch demand a token on EVERY call, not just the ones the handler's own
   *  check flags, which is a real behavior change this field must never cause.
   *
   *  It exists purely so the WIRE annotation can stop lying: the MCP spec's own default for
   *  `destructiveHint` is `true` ("cautious"), so a mutating tool that CAN demand confirmation and
   *  declares neither `destructive` nor this flag ends up advertising `destructive: false` — a
   *  false statement, not a conservative one. `mcp/facade.ts`'s `isAdvertisedDestructive` and
   *  `mcp/server.ts`'s `toolAnnotations` OR this in alongside `destructive` when rendering the wire
   *  annotation; every authorization/HITL/read-only gate in mcp/registry/policy-gates.ts reads ONLY
   *  the real `destructive` field above and must go on doing so. */
  conditionallyDestructive?: boolean;
  /** Tool-specific precondition gate. Runs AFTER scope+ACL and BEFORE the HITL/elicit
   *  stage, so a rejection never consumes the single-use elicit token (D5). Throw an
   *  ObsidianTcError to reject. */
  precheck?: (input: I, ctx: CallerContext) => Promise<void> | void;
  /** Override the governing throttle/metric scope class (E4). Defaults to scopeClassOf(requiredScopes). */
  scopeClass?: string;
  /** THE-414: declarative folder-ACL path extraction. Returns the vault-relative paths this tool
   *  touches, tagged by op, so runDispatch enforces the folder ACL centrally (right before the
   *  handler) instead of trusting each handler to call enforcePathAcl. Handler-side calls stay as
   *  defense-in-depth. Every path-touching tool MUST declare this (or sit in the guarantee test's
   *  documented exemption set); a mutating tool with neither fails the acl-extraction-coverage
   *  guarantee test. Extractors must mirror the handler's own enforcePathAcl calls exactly (same
   *  ops, same paths, same conditionals) so central enforcement never denies a call the handler
   *  would have allowed. */
  pathAcl?: (input: I) => ReadonlyArray<{ op: AclOp; path: string }>;
  /** THE-727: resolve authorization policy from the CALL rather than the definition.
   *
   *  A tool that dispatches on an `action` argument cannot honestly declare one static scope set:
   *  unioning makes a harmless read demand delete privileges, intersecting leaves a destructive
   *  action under-governed. Neither is acceptable, which is why read+write consolidation is blocked
   *  on this.
   *
   *  Same shape as `pathAcl` above and for the same reason — that field is already a function of
   *  the input, enforced centrally in runDispatch, so this generalizes a signature the pipeline
   *  already proves out rather than inventing one.
   *
   *  ABSENT -> the static `requiredScopes` / `destructive` / `scopeClass` are used verbatim, so
   *  every existing tool is untouched. This is purely additive.
   *
   *  `requiredScopes` here MUST be a SUBSET of the static `requiredScopes`, which stays the
   *  declared MAXIMUM the tool advertises. `resolveOperationPolicy` enforces that at runtime and
   *  refuses the call otherwise: a resolver returning a scope the tool never declared is an
   *  under-declaration, and the advertised surface would be lying about what the tool can do.
   *  Narrowing is the whole point; widening is a defect. */
  resolvePolicy?: (input: I) => OperationPolicy;
  handler: (input: I, ctx: CallerContext) => Promise<O> | O;
}

/** THE-727: the per-call authorization policy a tool resolves from its input.
 *
 *  Every field is optional except `requiredScopes`, and an omitted field falls back to the tool's
 *  static declaration — so a resolver that only varies scopes says only that. */
export interface OperationPolicy {
  /** MUST be a subset of the definition's static `requiredScopes`. Enforced, not documented. */
  requiredScopes: readonly string[];
  /** Drives the read-only gate, the vault-kind gate and the HITL floor. Omitted -> static. */
  destructive?: boolean;
  /** Drives throttling and metrics. Omitted -> static, else scopeClassOf(resolved scopes). */
  scopeClass?: string;
}

export type VerifyElicit = (token: string, expectedHash: string, ctx: CallerContext) => boolean;
export type Status = "ok" | "error" | "skipped";

/** THE-228: one dispatch outcome, as handed to the experiential episode bus. Carries the
 *  audit-row fields plus the raw parsed input; content policy (redact / cap / drop) belongs
 *  to the sink, never to the registry. */
export interface DispatchEpisode {
  ts: number;
  vaultId: string;
  tool: string;
  caller: string | null;
  sessionId: string | null;
  status: Status;
  errorCode: string | null;
  durationMs: number;
  resultSize: number;
  argsHash: string;
  /** Raw parsed input as received. */
  args: unknown;
}

/** One dispatch's coarse timing, reported to an onProfile sink (OBSIDIAN_TC_PROFILE). */
export interface DispatchProfile {
  tool: string;
  vaultId: string;
  total_ms: number;
  handler_ms: number;
}

export interface RegistryOptions {
  maxResponseBytes?: number;
  verifyElicit?: VerifyElicit;
  /** Prometheus recorder (G2.4). Optional: dispatch records nothing when it is absent. */
  metrics?: MetricsRecorder;
  /** OTEL tool tracer (G2.4). Optional: dispatch emits no spans when it is absent. */
  tracer?: Tracer;
  /** MORGIANA event sink (G2.4). Optional: dispatch emits no CloudEvents when it is absent. */
  emit?: (vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>) => void;
  /** Dispatch-wide rate limiter (THE-210). Optional: no rate gate when it is absent. */
  rateLimiter?: RateLimiter;
  /** Idempotency replay TTL in seconds (D3). Defaults to 86400 when absent. */
  idempotencyTtlSeconds?: number;
  /** THE-293: window (seconds) after which a crashed in-flight idempotency row may be
   *  reclaimed at dispatch. Default 60. */
  idempotencyReclaimSeconds?: number;
  /** Static tool-visibility scoping (THE-219). Optional: ALLOW_ALL when absent. */
  toolVisibility?: ToolVisibilityConfig;
  /** Profile sink (perf diagnostics). When set, each successful dispatch reports total vs
   *  handler time; absent by default, so there is no observable overhead. */
  onProfile?: (p: DispatchProfile) => void;
  /** THE-209 session tracer. When set, a dispatch whose ctx.sessionId is present appends a
   *  tool_invocation trace record to that session's JSONL (the transport wires the path). */
  /** THE-736: capture each dispatch's raw parsed arguments onto the session trace
   *  (`sessions.traceContent`). Off unless the operator opts in — see the schema for why. */
  traceContent?: boolean;
  sessionTracer?: (
    session: { vaultId: string; sessionId: string; caller: string | null },
    record: TraceRecord,
  ) => void;
  /** THE-295 per-vault ACL resolver. When the parsed input names a vault, dispatch swaps
   *  ctx.acl to that vault's ACL (root ACL = inherited default) so the readOnly gate and every
   *  handler-side enforcePathAcl run under the right vault's rules. */
  aclResolver?: (vaultId: string) => FolderAcl | undefined;
  /** THE-414 vault-root resolver. runDispatch uses it to resolve the filesystem root for the
   *  effective vault so central pathAcl enforcement can run the same symlink-canonical
   *  enforcePathAcl the handlers do. Wired from the VaultRegistry in cli.ts; when absent (unit
   *  tests that omit it) central enforcement is skipped and handler-side checks still apply. */
  rootResolver?: (vaultId: string) => string | undefined;
  /** THE-569 vault-kind resolver: the reverse of P1.5's read:docs gate. When wired, dispatch
   *  refuses any MUTATING call (destructive tools or a required scope in a mutating family) whose
   *  effective vault resolves to `docs` or `system` kind — a reserved docs/system corpus is
   *  read-only BY KIND, not just by token-provisioning convention. Read (non-mutating) calls on a
   *  docs/system vault stay allowed; this closes only the write/integrity direction. Absent (unit
   *  tests that omit it, or a registry built with no VaultRegistry) means no gating — a no-op. */
  vaultKindResolver?: (vaultId: string) => VaultKind | undefined;
  /** THE-288 internal-error sink. When a handler throws a non-typed exception (a server bug),
   *  the client response is redacted to `{code:"internal"}`; this sink receives the real error +
   *  stack for operator diagnosis. Never wired to stdout (the MCP channel); best-effort. */
  onInternalError?: (tool: string, vaultId: string, err: unknown) => void;
  /** THE-417 Phase 2: fired once per output-schema mismatch, in BOTH warn and strict mode. Carries
   *  only the tool name and vault — never the payload or the Zod issues, which would put note
   *  content into a metrics label. The `message` on the onInternalError line above is where a
   *  human-readable diagnosis lives. */
  onOutputSchemaDrift?: (tool: string, vaultId: string) => void;
  /** THE-457: called when the fail-open audit write throws (locked DB, disk full, migration drift).
   *  Already counted as a metric; this sink lets the composition root also surface it in server_health
   *  so an operator watching health (not metrics) sees the audit trail going lossy. Best-effort. */
  onAuditFailure?: (tool: string, vaultId: string) => void;
  /** THE-228 episode capture. Called once per dispatch outcome (every dispatch, session or
   *  not) with the audit-row fields + raw parsed input; the experiential capture bus persists
   *  it. Best-effort by contract: sink failures are swallowed and never break dispatch. */
  onEpisode?: (e: DispatchEpisode) => void;
  /** THE-457: when true, a handler payload that violates its advertised `outputSchema` is a hard,
   *  typed `internal_error` instead of a logged warning that still returns the malformed payload.
   *  Off by default (production stays warn-only for backward compatibility); enable it in dev/CI so
   *  output-schema drift fails a test rather than reaching a client that may reject it. */
  strictOutputSchema?: boolean;
}
