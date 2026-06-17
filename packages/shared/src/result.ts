import type { ErrorJSON } from "./errors";

export interface ToolMeta {
  duration_ms: number;
  result_size: number;
  overflow_bytes?: number;
  explain?: unknown;
}
export interface ToolOk<T = unknown> { ok: true; data: T; meta: ToolMeta; }
export interface ToolErr { ok: false; error: ErrorJSON; meta: ToolMeta; }
export type ToolResult<T = unknown> = ToolOk<T> | ToolErr;
