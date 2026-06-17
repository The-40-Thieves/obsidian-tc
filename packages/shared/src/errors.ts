export type ErrorCode =
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
  | "internal";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "idempotency_in_flight",
  "throttled",
  "internal",
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
} as const;
