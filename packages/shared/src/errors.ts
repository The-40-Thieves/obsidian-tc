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
  | "bases_syntax_error";

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
]);

export interface ErrorJSON {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
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
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
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
} as const;
