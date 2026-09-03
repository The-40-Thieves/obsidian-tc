export type ErrorCode =
  // M0 dispatch + foundation codes (locked by M0 tests; do not rename).
  | "unauthorized"
  | "forbidden"
  | "validation_error"
  | "not_found"
  | "vault_not_found"
  | "conflict"
  | "idempotency_key_mismatch"
  | "idempotency_in_flight"
  | "elicit_required"
  | "elicit_invalid"
  | "overflow"
  | "throttled"
  | "read_only"
  | "plugin_unavailable"
  | "internal"
  // M1 (G2.1 tool-surface) codes — thrown by tool handlers.
  | "note_not_found"
  | "path_invalid"
  | "path_ambiguous"
  | "acl_denied"
  | "read_only_mode"
  | "note_exists"
  | "concurrent_modification"
  | "invalid_input"
  | "internal_error"
  // M2 (G2.1 Domain 6 search + retrieval substrate) codes — additive, do not rename.
  | "embedding_provider_error"
  | "operation_timeout"
  | "dql_error"
  | "jsonlogic_error"
  | "plugin_missing"
  | "plugin_unreachable"
  // M3 (G2.1 Domains 7-8,12,18-20 structured formats) codes — additive, do not rename.
  | "bases_syntax_error"
  | "unsupported_base_filter"
  // M4 (G2.1 Domain 26 command palette) codes — additive, do not rename.
  | "execute_command_disabled"
  | "command_not_allowlisted"
  // M-headless (THE-255) — typed Tier-3 degrade when the vault is headless.
  | "requires_live_obsidian"
  // THE-293 — deterministic compute-budget rejection (regex execution timeout / JSONLogic op
  // budget). Never retryable: the same input re-hangs identically.
  | "compute_budget_exceeded"
  // THE-282 — the companion answers /probe with a different API major: a PERMANENT mismatch
  // (plugin_unreachable is retryable, which would invite pointless client retries).
  | "plugin_incompatible"
  // THE-562 #13 — a prior attempt with this idempotency key committed its effect but faulted
  // before recording a result (or crashed). NOT auto-retryable: the caller must verify state
  // before deciding whether to retry, since blindly retrying is exactly what this prevents.
  | "indeterminate_outcome"
  // THE-514 — the caller's AbortSignal fired before (or during) dispatch. Distinct from
  // `internal`/`operation_timeout`: nothing failed, the caller withdrew the request, so a
  // fresh call (not a blind retry of this exact attempt) is the expected recovery.
  | "aborted"
  // THE-639 — write_note/append_note's `provenance: "agent_synthesis"` poison-scan gate
  // (assessPoison). Distinct from `invalid_input`: the argument SHAPE was fine, the CONTENT was
  // refused. Never retryable — the same content re-scans identically; the caller must revise it
  // or write it as `provenance: "authored"` if a human is vouching for it.
  | "content_rejected"
  // THE-934 fix round 3 (H) — the egress port guard (plane/egress-filter.ts's
  // EgressViolationError) refused a content-bearing gateway/embedding/reranker request: either it
  // declared no sourcePaths at all, or one of its declared paths matches egress.excludePaths.
  // Never retryable — the same request re-refuses identically until the caller fixes the
  // declaration or the excluded path is genuinely no longer excluded.
  | "egress_excluded";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "idempotency_in_flight",
  "throttled",
  "internal",
  "internal_error",
  // G2.1: a CAS miss is retryable after the caller re-reads the note.
  "concurrent_modification",
  // M2: transient embedding-backend, timeout, and plugin-unreachable failures are retryable.
  "embedding_provider_error",
  "operation_timeout",
  "plugin_unreachable",
  // THE-514: cancellation is caller-driven, not a property of the input — re-issuing is expected.
  "aborted",
]);

/**
 * THE-512: what to DO about each failure, keyed on the code alone.
 *
 * Two properties fall out of that keying, and both are the point:
 *
 *  - **Cannot leak.** A hint is a fixed string selected by `code`. No path, query, caller,
 *    vault or argument can reach it, because none of them is in scope. THE-512 asks for hints
 *    that carry no sensitive data; this makes that structural rather than a review promise.
 *  - **Cannot drift per tool.** `ObsidianTcError.toJSON()` is the single serializer for every
 *    error in the system (dispatch, bulk item outcomes, tool handlers), so the same failure
 *    reads the same way everywhere. THE-512's "consistent across domains" requirement is
 *    satisfied by construction, not by 146 hand-written hints agreeing with each other.
 *
 * `Record<ErrorCode, ...>` is deliberate: it is exhaustive, so adding a code to `ErrorCode`
 * fails to compile until it declares a hint. `null` means "no hint helps" — a considered
 * choice, not an omission. Guidance that only restates `message` is noise, so it is omitted.
 *
 * Hints complement `retryable`, which says *whether* to retry; these say *what to do instead*.
 */
const RECOVERY: Record<ErrorCode, string | null> = {
  // M0 dispatch + foundation.
  unauthorized:
    "Authenticate first: send a credential this server accepts, then re-issue the call.",
  forbidden:
    "Missing a required scope (details.required lists it). Re-authenticate with a credential that grants it, or call inspect_acl to see what this caller may reach.",
  validation_error:
    "Read the tool's inputSchema via describe_capability and correct the arguments; details names the offending field where one could be identified.",
  not_found:
    "Confirm the target exists before retrying — note_exists checks one path, list_notes enumerates, and search_vault finds by content when the exact path is unknown.",
  vault_not_found:
    "Use one of the ids from list_vaults, or register the vault first with add_vault (no restart needed).",
  conflict: "Re-read the current state, re-apply the change on top of it, and retry.",
  idempotency_key_mismatch:
    "This key was already used with different arguments. Use a fresh key — reusing one with changed input is what this rejects.",
  idempotency_in_flight:
    "An earlier call with this key is still running. Wait and retry the SAME key; issuing a new one would apply the effect twice.",
  // THE-826: names the CLI escape hatch for a client that cannot render the elicitation prompt
  // itself (a modern client still gets the inputRequired round trip, unaffected).
  elicit_required:
    "A human must approve this call. A client with MCP elicitation gets an inputRequired prompt; otherwise mint one with `obsidian-tc elicit --hash <args_hash> --tool <name>` and resend. Never reuse an old token.",
  elicit_invalid:
    "The token was rejected or expired. Re-issue the original call with no token to trigger a fresh confirmation prompt.",
  overflow:
    "The response exceeded the byte budget. Narrow the request — a smaller limit, fewer paths, or a compact/paginated read — rather than retrying unchanged.",
  throttled:
    "Rate limit for this scope class. Back off before retrying, and reduce batch size or spread the calls; a tight retry loop will keep hitting it.",
  read_only:
    "The server is in read-only mode, so no write will succeed until that changes. Use a read tool, or take this up with whoever runs the server.",
  plugin_unavailable:
    "The companion plugin is not answering. Check Obsidian is running with the Local REST API enabled, then re-probe with refresh_plugin_capabilities.",
  internal:
    "Unexpected server-side failure. Retryable once; if it persists, check server_health and the server log rather than retrying further.",
  // M1 — tool-surface codes.
  note_not_found:
    "Confirm the path first: note_exists checks it, list_notes enumerates the folder, search_vault finds the note by content.",
  path_invalid:
    "Paths are vault-relative, must stay inside the vault, and must not traverse upward. Rewrite the path rather than retrying it.",
  path_ambiguous:
    "More than one note matches. Pass the full vault-relative path — list_notes or search_vault will show the candidates to choose between.",
  acl_denied:
    "This path is outside the folder ACL for this caller. Call inspect_acl to see which roots are permitted and retry within one of them.",
  read_only_mode:
    "This vault is configured read-only. Target a writable vault, or change the vault's configuration; retrying cannot help.",
  note_exists:
    "Something is already at that path. Choose a different path, or use the tool's overwrite/append option if it has one.",
  concurrent_modification:
    "The note changed after you read it. Re-read it, re-apply your edit to the new content, and retry with the fresh CAS token — do not retry the stale one.",
  invalid_input:
    "Check the argument types and required fields against describe_capability's inputSchema before retrying.",
  internal_error:
    "Unexpected failure inside the handler. Retryable once; if it persists, capture the call and check the server log.",
  // M2 — search + retrieval substrate.
  embedding_provider_error:
    "The embedding backend failed. Retryable; if it persists, confirm the provider is reachable and the configured model is present (server_health reports the provider).",
  operation_timeout:
    "The operation exceeded its time budget. Retryable, but narrow it first — a smaller limit or a more selective query is more likely to finish.",
  dql_error:
    "Dataview rejected the query. Check it with validate_dql, which reports the syntax error without running it.",
  jsonlogic_error:
    "The JSONLogic expression is malformed. Verify the operator names and that every operator's argument arity matches.",
  plugin_missing:
    "The required Obsidian plugin is not installed or not enabled. Enable it in Obsidian, then run refresh_plugin_capabilities so the server re-probes.",
  plugin_unreachable:
    "The plugin is present but its endpoint failed. Retryable; check Obsidian is running and the Local REST API is enabled and reachable.",
  // M3 — structured formats.
  bases_syntax_error:
    "The .base file's YAML or filter syntax is invalid. Fix the file — read_base shows how the server parses it.",
  unsupported_base_filter:
    "This base uses Obsidian's Bases expression DSL, which query_base does not evaluate. Read the base and filter the rows yourself, or simplify the base's filter.",
  // M4 — command palette.
  execute_command_disabled:
    "Command execution is off for this vault. It must be enabled in configuration; this is a policy decision, not a transient failure.",
  command_not_allowlisted:
    "The command is not in this vault's allowlist. Add it there (deny-by-default is intentional) — list_commands shows what is currently permitted.",
  // M-headless.
  requires_live_obsidian:
    "This capability needs a live Obsidian connection and the vault is headless. Start Obsidian with the Local REST API, or use a filesystem-only equivalent.",
  // THE-293.
  compute_budget_exceeded:
    "The input exhausted its compute budget and will do so again identically — do not retry. Simplify the pattern or expression, or narrow what it runs over.",
  // THE-282.
  plugin_incompatible:
    "The companion plugin's API major does not match this server's. Permanent until one side is upgraded; retrying will not help.",
  // THE-562 #13 — the one hint that prevents a destructive retry.
  indeterminate_outcome:
    "A previous attempt with this idempotency key committed its effect but never recorded the result. Do NOT blindly retry: read the target state first, and only re-issue (with a NEW key) if the effect did not land.",
  // THE-514 — abort is cancellation, not failure.
  aborted:
    "The caller's AbortSignal fired before the operation finished. Re-issue the call fresh if the work is still wanted; this is not a transient failure of the operation itself.",
  // THE-639 — poison-scan gate on agent_synthesis note writes.
  content_rejected:
    'The content tripped the poison scan (risk: high) and was not written. Revise it to remove instruction-override, persistence-directive, hidden-text, or exfiltration-like phrasing, or write it with provenance: "authored" if a human is vouching for it.',
  // THE-934 fix round 3 (H) — the egress port guard refused a content-bearing request.
  egress_excluded:
    "A gateway/embedding/reranker request either declared no sourcePaths or named one under egress.excludePaths. Declare the real vault paths the text came from (an empty array is fine when there genuinely are none), or leave the excluded path out of the request.",
};

/** THE-512: the recovery hint for a code, or undefined when none is useful. */
export function recoveryFor(code: ErrorCode): string | undefined {
  return RECOVERY[code] ?? undefined;
}

export interface ErrorJSON {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  /** THE-512: bounded, static next-step guidance for this error code. Absent when no hint helps. */
  recovery?: string;
}

export class ObsidianTcError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ObsidianTcError";
    this.code = code;
    this.details = details;
    this.retryable = RETRYABLE.has(code);
    Object.setPrototypeOf(this, ObsidianTcError.prototype);
  }

  toJSON(): ErrorJSON {
    const recovery = recoveryFor(this.code);
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(recovery ? { recovery } : {}),
    };
  }
}

/**
 * THE-926: does `e` represent a failure that a per-leg/per-variant fan-out isolation layer (THE-448's
 * multiQueryGraphSearch, THE-630's runFederatedLegs) must NOT silently swallow into an empty result
 * set for that leg?
 *
 * The obvious first attempt — "rethrow when `!e.retryable`" — does NOT work: `retryable` says
 * whether *retrying the same call* is worth trying, which is orthogonal to whether a fan-out layer
 * may treat the failure as "this one leg found nothing" and move on. `chunk_fts.ts`'s
 * `assertContentlessChunkFts` (THE-750) is the case that proves it — it throws `code: "internal"`,
 * which `RETRYABLE` lists (a generic "unexpected failure, retryable once" default), yet it is
 * exactly the deliberate, permanent refusal this predicate exists to let through: re-running the
 * same query re-hits the same pre-migration table shape and refuses identically every time.
 *
 * So the actual split is: an ObsidianTcError with code `"internal"` (the generic bucket for
 * "something the caller could not have anticipated went wrong," which in this codebase only ever
 * covers unexpected/structural failures — never a domain-specific transient one, which gets its own
 * code) OR one that is `retryable === false` (a domain-specific permanent refusal — validation,
 * ACL, budget-exceeded, poison-scan, ...) must propagate. Only the domain-specific RETRYABLE codes
 * (`embedding_provider_error`, `operation_timeout`, `plugin_unreachable`, `concurrent_modification`,
 * `idempotency_in_flight`, `throttled`, `aborted`) describe a genuinely transient per-leg hiccup
 * that a fan-out may swallow and still make forward progress on the other legs.
 *
 * A non-`ObsidianTcError` (a bare `Error`, a rejected promise from something outside this error
 * taxonomy) is never "loud" by this predicate — it is exactly the unmodeled, per-leg transient case
 * the existing swallow-and-continue behavior was built for.
 */
export function isLoudRefusal(e: unknown): e is ObsidianTcError {
  return e instanceof ObsidianTcError && (e.code === "internal" || !e.retryable);
}

type Mk = (message?: string, details?: Record<string, unknown>) => ObsidianTcError;
const mk =
  (code: ErrorCode, fallback: string): Mk =>
  (message = fallback, details?) =>
    new ObsidianTcError(code, message, details);

export const err = {
  // M0
  unauthorized: mk("unauthorized", "authentication required"),
  forbidden: mk("forbidden", "scope or ACL denied"),
  validation: mk("validation_error", "input validation failed"),
  notFound: mk("not_found", "not found"),
  vaultNotFound: mk("vault_not_found", "vault not found"),
  conflict: mk("conflict", "conflict"),
  elicitRequired: mk("elicit_required", "human confirmation required"),
  elicitInvalid: mk("elicit_invalid", "elicit token invalid or expired"),
  overflow: mk("overflow", "response exceeds byte budget"),
  throttled: mk("throttled", "rate limit exceeded"),
  readOnly: mk("read_only", "server is in read-only mode"),
  internal: mk("internal", "internal error"),
  // M1
  noteNotFound: mk("note_not_found", "note not found"),
  pathInvalid: mk("path_invalid", "path is invalid"),
  pathAmbiguous: mk("path_ambiguous", "path resolves to multiple notes"),
  aclDenied: mk("acl_denied", "path denied by folder ACL"),
  readOnlyMode: mk("read_only_mode", "vault is in read-only mode"),
  noteExists: mk("note_exists", "note already exists"),
  concurrentModification: mk("concurrent_modification", "note changed since it was read"),
  invalidInput: mk("invalid_input", "invalid input"),
  internalError: mk("internal_error", "internal error"),
  // M2 — G2.1 Domain 6 search + retrieval substrate.
  embeddingProviderError: mk("embedding_provider_error", "embedding provider failed"),
  operationTimeout: mk("operation_timeout", "operation timed out"),
  dqlError: mk("dql_error", "Dataview DQL error"),
  jsonlogicError: mk("jsonlogic_error", "JSONLogic expression invalid"),
  pluginMissing: mk("plugin_missing", "required Obsidian plugin not detected"),
  pluginUnreachable: mk("plugin_unreachable", "plugin detected but REST endpoint failed"),
  // M3 — G2.1 structured-format domains (Bases).
  basesSyntaxError: mk("bases_syntax_error", "invalid .base YAML or filter syntax"),
  unsupportedBaseFilter: mk(
    "unsupported_base_filter",
    "base uses the Obsidian Bases expression DSL, which query_base does not evaluate",
  ),
  // M4 — G2.1 Domain 26 command palette (deny-by-default command execution).
  executeCommandDisabled: mk(
    "execute_command_disabled",
    "command execution is disabled for this vault",
  ),
  commandNotAllowlisted: mk("command_not_allowlisted", "command is not in the vault allowlist"),
  // M-headless (THE-255) — Tier-3 tools degrade to this headless (see vault/mode.ts assertLive).
  requiresLiveObsidian: mk(
    "requires_live_obsidian",
    "this operation requires a live Obsidian (Local REST API) connection",
  ),
  // THE-293 — compute-abuse budgets (regex execution timeout).
  computeBudgetExceeded: mk("compute_budget_exceeded", "operation exceeded its compute budget"),
  // THE-282 — companion API-version floor.
  pluginIncompatible: mk(
    "plugin_incompatible",
    "companion plugin API version is incompatible with this server",
  ),
  // THE-514 — cooperative AbortSignal cancellation.
  aborted: mk("aborted", "operation aborted by caller"),
  // THE-639 — assessPoison gate on write_note/append_note's provenance: "agent_synthesis" path.
  contentRejected: mk("content_rejected", "content rejected by poison scan"),
} as const;
