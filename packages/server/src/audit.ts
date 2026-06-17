import type { Database } from "./db/types";

export interface AuditEvent {
  ts: number;
  vault_id?: string | null;
  tool_name?: string | null;
  caller?: string | null;
  duration_ms?: number | null;
  result_size?: number | null;
  status: "ok" | "error" | "skipped";
  error_code?: string | null;
  args_hash?: string | null;
  event_type?: string | null;
}

export function writeEvent(db: Database, e: AuditEvent): void {
  db.prepare(
    `INSERT INTO event_log
      (ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.ts, e.vault_id ?? null, e.tool_name ?? null, e.caller ?? null,
    e.duration_ms ?? null, e.result_size ?? null, e.status,
    e.error_code ?? null, e.args_hash ?? null, e.event_type ?? "tool_invocation",
  );
}
