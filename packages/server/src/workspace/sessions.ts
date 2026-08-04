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
import { resolveVaultPathChecked } from "../vault/paths";

/** Stable session id, e.g. "sess_9f2c…". 12 random bytes = 24 hex chars. */
export function genSessionId(): string {
  return `sess_${randomBytes(12).toString("hex")}`;
}

/** Default vault folder for workspace-session JSONL traces. Lives here, beside `traceRelPath`,
 *  because this module computes trace paths and the HTTP transport (THE-726 server-opened
 *  sessions) needs the same fallback m5 uses; tools/m5/shared.ts re-exports it. */
export const DEFAULT_TRACE_FOLDER = ".obsidian-tc/traces";

/** Vault-relative JSONL trace path for a session: <traceFolder>/<sessionId>.jsonl. */
export function traceRelPath(traceFolder: string, sessionId: string): string {
  const f = traceFolder.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${f}/${sessionId}.jsonl`;
}

/** THE-610: absolute trace directory per vault, for the maintenance sweep's filesystem arm.
 *
 *  Lives here rather than in the sweep because "where a vault's traces are" is this module's
 *  concern, and it must stay consistent with `traceRelPath` above — the sweep deletes exactly the
 *  files `appendTrace` creates. Note EVERY vault gets an entry, not only those with a `workspace`
 *  block: `traceFolderFor` falls back to the same default and `registerM5Tools` is unconditional,
 *  so a vault that never configured workspace still accumulates traces once the session tools are
 *  called. Sweeping only configured vaults would miss exactly the case THE-610 exists for.
 *
 *  CONTAINMENT IS NOT OPTIONAL HERE. This computes a directory the sweep will DELETE files from,
 *  and `traceFolder` is only `z.string().min(1)` in the schema — nothing stops `..`. A bare
 *  `join(vaultRoot, folder)` is not a containment check: `join("/v", "../../tmp/evil")` is
 *  `/tmp/evil`. So this reuses the very primitive the WRITE path uses (`resolveVaultPathChecked`,
 *  via `traceRelPath`'s own normalization), which rejects `..`, absolute paths and symlinked
 *  ancestors. Any delete path must be at least as strict as the write path that created the files.
 *
 *  It THROWS rather than skipping. A `traceFolder` that escapes the vault already makes every
 *  `start_session` fail at `resolveVaultPath`, so such a config is broken either way — refusing at
 *  boot turns a latent per-call error into an immediate, legible one, and silently skipping the
 *  vault would leave its traces growing forever, which is the bug this ticket exists to fix. */
export function resolveTraceDirs(
  vaults: readonly { id: string; path: string; workspace?: { traceFolder: string } }[],
  defaultFolder: string,
): Array<{ vaultId: string; dir: string }> {
  return vaults.map((v) => {
    const folder = v.workspace?.traceFolder ?? defaultFolder;
    // Normalize exactly as traceRelPath does before resolving. Without this a backslash in the
    // folder makes the write path store under `a/b` while the sweep looks for the literal `a\b`
    // on POSIX — a directory that never exists, so the sweep reports 0 forever while files pile up.
    const rel = folder.replace(/\\/g, "/").replace(/\/+$/, "");
    return { vaultId: v.id, dir: resolveVaultPathChecked(v.path, rel).abs };
  });
}

export interface SessionRow {
  id: string;
  vault_id: string;
  caller: string | null;
  started_at: number;
  ended_at: number | null;
  trace_path: string;
  metadata_json: string | null;
  /** THE-627: client software identity, from the MCP request's `_meta`. NULL when the client sent
   *  none — which is every client under the current spec, so NULL is the normal value, not a gap. */
  client_name: string | null;
  client_version: string | null;
  /** THE-726: the server-OBSERVED principal that owns this session (`ctx.caller`), as distinct from
   *  `caller` above, which is the caller-SUPPLIED `input.caller`. Only this column may resolve an
   *  active session — see `activeSessionFor`. NULL on rows written before 20260804_001, which
   *  correctly makes them unresolvable rather than resolvable-as-someone. */
  principal: string | null;
}

const SESSION_COLS =
  "id, vault_id, caller, started_at, ended_at, trace_path, metadata_json, client_name, client_version, principal";

export interface InsertSessionInput {
  id: string;
  vaultId: string;
  caller: string | null;
  startedAt: number;
  tracePath: string;
  metadata?: unknown;
  /** THE-627: observed by the server from the request, NOT caller-supplied like `metadata`. Written
   *  once at session creation and never updated — first-write-wins is the rule, and it comes for
   *  free because there is no update path. That matters because `_meta` is per-REQUEST under MCP
   *  2026-07-28, so two calls sharing a sessionId could in principle disagree; the session is
   *  identified by whoever opened it. */
  clientInfo?: { name: string; version?: string };
  /** THE-726: the server-observed principal (`ctx.caller`). NOT `caller` — that one is the
   *  caller-supplied declaration and cannot be trusted to identify who is calling. Optional so a
   *  transport with no authenticated principal writes NULL rather than a fabricated value. */
  principal?: string | null;
}

export function insertSession(db: Database, input: InsertSessionInput): SessionRow {
  db.prepare(
    `INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path, metadata_json, client_name, client_version, principal)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.vaultId,
    input.caller,
    input.startedAt,
    input.tracePath,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    // NULL, never a placeholder: a literal "unknown" would be indistinguishable from a client that
    // genuinely reports that name — a failure encoded as a valid domain value (the THE-613 shape).
    input.clientInfo?.name ?? null,
    input.clientInfo?.version ?? null,
    input.principal ?? null,
  );
  return getSession(db, input.id) as SessionRow;
}

/**
 * THE-726: resolve a principal's currently-open session DURABLY, from SQLite rather than from
 * ActiveSessionTracker's process-local map. This is what lets a session survive a restart and, more
 * importantly, what lets the HTTP transport have sessions at all — it never had access to the
 * in-memory tracker, which is why `session_id` was NULL on 100% of live rows.
 *
 * Keyed on `principal` (server-observed) and NEVER on `caller` (caller-supplied). Resolving by a
 * declared value would let any client holding `write:workspace` claim another principal's session
 * id, and a session id is the correlation key for that principal's retrieval history.
 *
 * A NULL principal never matches, by construction: `WHERE principal = ?` is false for NULL on both
 * sides, and the supporting index excludes NULLs. So a pre-migration row, or one opened over a
 * transport with no authenticated principal, is unresolvable rather than resolvable-as-someone.
 *
 * Returns the most recent open session when several exist. The schema does not enforce one-per-
 * principal and this must not assume it — a client that calls start_session twice without ending
 * the first is doing something legal, and the newest is the honest answer.
 */
export function activeSessionFor(
  db: Database,
  principal: string | null | undefined,
): { sessionId: string; vaultId: string } | undefined {
  if (principal === null || principal === undefined || principal === "") return undefined;
  const row = db
    .prepare(
      `SELECT id, vault_id FROM workspace_sessions
        WHERE principal = ? AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(principal) as { id: string; vault_id: string } | undefined;
  return row ? { sessionId: row.id, vaultId: row.vault_id } : undefined;
}

/**
 * THE-726: open a session the SERVER decided to open, for a principal that has none.
 *
 * `workspace_sessions` was empty for one reason: opening a session is a deliberate act and no
 * client performs it. #691/#692 made the HTTP transport able to CARRY a session; this is what
 * makes one exist. Off unless `sessions.autoOpen` — correlation changes what the server retains
 * about who read what, and the epic makes privacy a design input rather than a follow-up.
 *
 * `caller` is deliberately NULL, and that is load-bearing rather than lazy. `start_session`'s input
 * schema requires `caller: z.string().min(1)`, so a NULL `caller` with a non-NULL `principal` is a
 * shape only this function can produce. The maintenance sweep uses exactly that predicate to close
 * server-opened sessions without touching a deliberate one — no extra column, and the distinction
 * is enforced by a schema that already exists rather than by a flag someone can forget to set.
 *
 * No trace file is written here. `start_session` writes a `session_start` record because a client
 * declared something worth recording; the server has nothing to declare, and `readTrace` already
 * treats a missing file as an empty trace. `trace_path` is still computed and stored so that if
 * dispatch-level tracing (THE-209/THE-175) ever appends to this session, it appends where
 * `get_session_traces` will look for it.
 */
export function openImplicitSession(
  db: Database,
  input: { principal: string; vaultId: string; traceFolder: string; now: number },
): { sessionId: string; vaultId: string } {
  const id = genSessionId();
  // The FOLDER is the parameter, never a finished path: `traceRelPath` derives the filename from
  // the session id, and the id is minted here. Taking a path from the caller would let it be
  // computed against a different (earlier-minted) id, storing a trace_path that names a session
  // that does not exist — get_session_traces would then read an unrelated file or none at all.
  insertSession(db, {
    id,
    vaultId: input.vaultId,
    caller: null,
    startedAt: input.now,
    tracePath: traceRelPath(input.traceFolder, id),
    principal: input.principal,
  });
  return { sessionId: id, vaultId: input.vaultId };
}

/**
 * THE-726: close server-opened sessions older than the configured window.
 *
 * A WINDOW, not an idle timeout — see SessionsConfigSchema for why. An idle timeout needs a
 * `last_activity_at` column and a write on every request (or a throttle across them); a window
 * needs neither, and the cost is that a task spanning a boundary splits across two sessions.
 *
 * `caller IS NULL` is the whole safety property: a session a client opened deliberately is never
 * closed here, because only `end_session` may decide a declared session is over. Left unbounded,
 * server-opened sessions would otherwise stay open forever and `activeSessionFor` would keep
 * correlating a principal's retrievals to a session opened days earlier.
 */
export function closeStaleImplicitSessions(
  db: Database,
  opts: { now: number; windowSeconds: number },
): number {
  const cutoff = opts.now - opts.windowSeconds * 1000;
  return db
    .prepare(
      `UPDATE workspace_sessions SET ended_at = ?
        WHERE ended_at IS NULL AND caller IS NULL AND principal IS NOT NULL AND started_at < ?`,
    )
    .run(opts.now, cutoff).changes;
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

/**
 * In-process registry of each caller's currently-active workspace session (THE-209).
 * `start_session` registers the caller's session, `end_session` clears it, and the
 * transport context factory reads it to stamp `ctx.sessionId` so dispatch appends a
 * tool_invocation record to that session's JSONL trace. Process-local and best-effort:
 * not persisted, so a restart simply resumes untracked until the next start_session.
 */
export class ActiveSessionTracker {
  private readonly byCaller = new Map<string, { sessionId: string; vaultId: string }>();
  set(caller: string | null, sessionId: string, vaultId: string): void {
    this.byCaller.set(caller ?? "", { sessionId, vaultId });
  }
  get(caller: string | null): { sessionId: string; vaultId: string } | undefined {
    return this.byCaller.get(caller ?? "");
  }
  clear(caller: string | null, sessionId: string): void {
    const key = caller ?? "";
    if (this.byCaller.get(key)?.sessionId === sessionId) this.byCaller.delete(key);
  }
}
