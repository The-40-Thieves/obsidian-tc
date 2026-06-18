// Workspace session + JSONL trace model (M5 / THE-181, G2.1 Domain 23).
//
// A workspace session is a row in workspace_sessions plus an append-only JSONL trace
// file. The trace is the durable, newline-delimited event log a session accumulates;
// `appendTrace` is the STABLE write contract the ambient capture worker (THE-175) and
// any future dispatch-level tracer target — one JSON object per line, never rewritten.
// The file path itself is computed vault-relative by the caller and validated with
// resolveVaultPath + enforcePathAcl before these helpers ever touch disk; the helpers
// take an already-resolved absolute path.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "../db/types";

/** Stable session id, e.g. "sess_9f2c…". 12 random bytes = 24 hex chars. */
export function genSessionId(): string {
  return `sess_${randomBytes(12).toString("hex")}`;
}

/** Vault-relative JSONL trace path for a session: <traceFolder>/<sessionId>.jsonl. */
export function traceRelPath(traceFolder: string, sessionId: string): string {
  const f = traceFolder.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${f}/${sessionId}.jsonl`;
}

export interface SessionRow {
  id: string;
  vault_id: string;
  caller: string | null;
  started_at: number;
  ended_at: number | null;
  trace_path: string;
  metadata_json: string | null;
}

const SESSION_COLS = "id, vault_id, caller, started_at, ended_at, trace_path, metadata_json";

export interface InsertSessionInput {
  id: string;
  vaultId: string;
  caller: string | null;
  startedAt: number;
  tracePath: string;
  metadata?: unknown;
}

export function insertSession(db: Database, input: InsertSessionInput): SessionRow {
  db.prepare(
    `INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path, metadata_json)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.vaultId,
    input.caller,
    input.startedAt,
    input.tracePath,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );
  return getSession(db, input.id) as SessionRow;
}

export function getSession(db: Database, id: string): SessionRow | undefined {
  return db.prepare(`SELECT ${SESSION_COLS} FROM workspace_sessions WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
}

/** Finalize a session. Idempotent: only an unended session is closed, so a double
 *  end_session reports changes=0 rather than overwriting the original ended_at. */
export function endSession(db: Database, id: string, endedAt: number): { changes: number } {
  const res = db
    .prepare("UPDATE workspace_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
    .run(endedAt, id);
  return { changes: res.changes };
}

/** Sessions whose start falls in [from, to] (either bound optional), newest first. */
export function sessionsInWindow(
  db: Database,
  vaultId: string,
  from?: number,
  to?: number,
): SessionRow[] {
  const clauses = ["vault_id = ?"];
  const params: unknown[] = [vaultId];
  if (from !== undefined) {
    clauses.push("started_at >= ?");
    params.push(from);
  }
  if (to !== undefined) {
    clauses.push("started_at <= ?");
    params.push(to);
  }
  return db
    .prepare(
      `SELECT ${SESSION_COLS} FROM workspace_sessions WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC`,
    )
    .all(...params) as SessionRow[];
}

export interface TraceRecord {
  ts: number;
  type?: string;
  tool?: string;
  caller?: string | null;
  duration_ms?: number;
  args_hash?: string;
  result_size?: number;
  [key: string]: unknown;
}

/**
 * Append one trace record as a single JSONL line. Append-only: the file is never
 * rewritten, so concurrent appends from one process serialize on the synchronous
 * write and never interleave a partial line. This is the stable contract THE-175's
 * ambient worker targets. `abs` must already be a resolved, ACL-checked path.
 */
export function appendTrace(abs: string, record: TraceRecord): void {
  mkdirSync(dirname(abs), { recursive: true });
  appendFileSync(abs, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Read a JSONL trace back into records. A missing file is an empty trace (not an
 * error). Blank lines are skipped; an unparseable line (e.g. a torn final write) is
 * skipped rather than aborting the whole replay.
 */
export function readTrace(abs: string): TraceRecord[] {
  if (!existsSync(abs)) return [];
  const out: TraceRecord[] = [];
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      out.push(JSON.parse(t) as TraceRecord);
    } catch {
      // torn / corrupt line — skip, keep replaying
    }
  }
  return out;
}
