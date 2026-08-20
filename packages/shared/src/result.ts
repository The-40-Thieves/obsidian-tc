import type { ErrorJSON } from "./errors";

export interface ToolMeta {
  duration_ms: number;
  result_size: number;
  overflow_bytes?: number;
  explain?: unknown;
  /** THE-741: set when this result was served from the idempotency cache — the handler did NOT
   *  run. Stamped at every replay path (ok, terminal-overflow, indeterminate), never on a call
   *  that actually executed. Absent (not `false`) on every non-replay result. */
  idempotent_replay?: boolean;
}
export interface ToolOk<T = unknown> {
  ok: true;
  data: T;
  meta: ToolMeta;
}
export interface ToolErr {
  ok: false;
  error: ErrorJSON;
  meta: ToolMeta;
}
export type ToolResult<T = unknown> = ToolOk<T> | ToolErr;
