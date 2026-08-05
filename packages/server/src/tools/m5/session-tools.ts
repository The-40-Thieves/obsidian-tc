// Domain 23 — Workspace memory + JSONL traces (G2.1). Three tools over the SQLite
// workspace_sessions table plus an append-only JSONL trace file per session:
// start_session, end_session, get_session_traces.
//
// THE-737: traces are CACHE-resident, not vault-relative. They used to live under the vault
// ("ACL-checked via enforcePathAcl", honoring THE-181 over G2.3's cache_dir sketch) — but a
// vault-resident trace is readable through `read_note`: `.obsidian-tc` is not in
// DEFAULT_DENY_ROOTS, and read_note takes a bare VaultPath with no extension restriction. So
// G2.3 was right after all, for a reason it did not state. Legacy rows still resolve against
// the vault and still get the folder-ACL check — see `traceAbsFor`. Reads take read:workspace,
// mutations take write:workspace (write family — readOnly kill-switch applies, no
// execute HITL floor; spec hitl:never). The append contract (appendTrace) is what the
// ambient capture worker (THE-175) targets to add tool-invocation records over time.
import { err, Pagination, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { inTransaction } from "../../db/txn";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import {
  appendTrace,
  cacheTraceRelPath,
  endSession,
  genSessionId,
  getSession,
  insertSession,
  readTrace,
  resolveCacheTracePath,
  resolveTraceAbs,
  type SessionRow,
  sessionsInWindow,
  type TraceRecord,
} from "../../workspace/sessions";
import { defineTool } from "../m1/define";
import type { M5Deps } from "./shared";

/**
 * THE-737 — resolve a session's trace file, applying the folder ACL only where it means something.
 *
 * A LEGACY (`trace_store = 'vault'`) row's trace is inside the vault, so the folder ACL still gates
 * it exactly as before — this does not weaken any existing deployment. A `'cache'` row's trace is
 * outside the vault: there is no vault path to check, and the tool's `read:workspace` /
 * `write:workspace` scope is the WHOLE control. That is a real reduction in defence-in-depth for
 * the new generation and is stated here rather than left to be discovered, because the alternative
 * -- keeping traces where the folder ACL applies -- is what made them readable via `read_note`.
 *
 * One function so no call site can forget which branch it is in.
 */
function traceAbsFor(
  deps: M5Deps,
  s: SessionRow,
  v: { root: string },
  ctx: CallerContext,
  op: "read" | "write",
): string {
  if (s.trace_store === "vault") enforcePathAcl(ctx.acl, op, s.trace_path, v.root);
  return resolveTraceAbs({
    store: s.trace_store,
    tracePath: s.trace_path,
    cacheDir: deps.cacheDir,
    vaultRoot: v.root,
  });
}

/** Parse an optional ISO-8601 date to epoch-ms; throws invalid_input on a bad value. */
function parseIso(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw err.invalidInput(`${field} is not a valid ISO date`, { [field]: value });
  return ms;
}

const StartSessionOutput = z.object({
  session_id: z.string(),
  vault: z.string(),
  started_at: z.number(),
  trace_path: z.string(),
});

const EndSessionOutput = z.object({
  session_id: z.string(),
  ended_at: z.number(),
  trace_path: z.string(),
  event_count: z.number(),
  duration_ms: z.number(),
});

// THE-417: mirrors TraceRecord (workspace/sessions.ts), which carries an index signature — the
// JSONL trace is appended to by multiple writers (session_start/session_end here, and the THE-175
// ambient capture worker over time), so its shape is only PARTIALLY known up front. The named
// fields are the ones this module itself writes; .catchall(z.unknown()) is the honest encoding of
// "and whatever else a writer put in this record", not a blanket z.any() escape hatch.
const TraceRecordOutput = z
  .object({
    session_id: z.string(),
    ts: z.number(),
    type: z.string().optional(),
    tool: z.string().optional(),
    caller: z.string().nullable().optional(),
    duration_ms: z.number().optional(),
    args_hash: z.string().optional(),
    result_size: z.number().optional(),
  })
  .catchall(z.unknown());

const GetSessionTracesOutput = z.object({
  vault: z.string(),
  items: z.array(TraceRecordOutput),
  next_cursor: z.string().nullable(),
  total_returned: z.number(),
});

export function buildSessionTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "start_session",
      domain: "knowledge",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      description:
        "Begin a workspace memory session: a SQLite row plus an append-only JSONL trace file.",
      inputSchema: z
        .object({
          vault: VaultId,
          caller: z.string().min(1),
          session_metadata: z.record(z.string(), z.unknown()).optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      outputSchema: StartSessionOutput,
      requiredScopes: ["write:workspace"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const now = (ctx.now ?? Date.now)();
        const id = genSessionId();
        // THE-737: traces are cacheDir-resident now, so there is no vault path to ACL-check.
        // `write:workspace` is the whole control here, and that is stated rather than inherited —
        // see `traceAbsFor` below for the legacy branch that still checks.
        const tracePath = cacheTraceRelPath(id);
        const abs = resolveCacheTracePath(deps.cacheDir, tracePath);
        // THE-572: two effects — a SQLite row and a JSONL trace file — that cannot share a
        // transaction. The row used to be inserted first, so an appendTrace throw left a durable
        // session row behind while dispatch deleted the idempotency claim, and a retry inserted a
        // SECOND row (genSessionId mints a fresh id, so nothing collides to stop it).
        //
        // Fix: write the trace first. Its path is derived from the session id, which is minted per
        // attempt, so a failed attempt's file is a self-contained orphan rather than a duplicate of
        // anything — and the authoritative row is what a retry must not duplicate.
        appendTrace(abs, {
          ts: now,
          type: "session_start",
          session_id: id,
          caller: input.caller,
          ...(input.session_metadata ? { metadata: input.session_metadata } : {}),
        });
        // The row and the idempotency marker are both writes on ctx.db, so they commit together:
        // a failed INSERT rolls the marker back too and the claim stays legitimately re-runnable.
        inTransaction(ctx.db, () => {
          ctx.markEffectCommitted?.();
          insertSession(ctx.db, {
            id,
            vaultId: v.id,
            caller: input.caller,
            startedAt: now,
            tracePath,
            metadata: input.session_metadata,
            // THE-627: server-observed client identity, kept separate from the caller-supplied
            // `session_metadata` above so an observation and a declaration stay distinguishable.
            ...(ctx.clientInfo ? { clientInfo: ctx.clientInfo } : {}),
            // THE-726: the same distinction, one field over. `caller` above is `input.caller` — a
            // required, caller-supplied string. `principal` is `ctx.caller`, which the transport
            // authenticated. Only `principal` may resolve this row as an active session
            // (`activeSessionFor`), because resolving on a declared value would let any client with
            // `write:workspace` claim another principal's session id.
            principal: ctx.caller,
          });
        });
        deps.activeSessions?.set(ctx.caller, id, v.id);
        return { session_id: id, vault: v.id, started_at: now, trace_path: tracePath };
      },
    }),

    defineTool({
      name: "end_session",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Finalize a workspace session, appending a session_end record to its JSONL trace.",
      inputSchema: z
        .object({
          vault: VaultId,
          session_id: z.string().min(1),
          end_metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
      outputSchema: EndSessionOutput,
      requiredScopes: ["write:workspace"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const s = getSession(ctx.db, input.session_id);
        if (!s || s.vault_id !== v.id)
          throw err.invalidInput("session not found", { session_id: input.session_id });
        if (s.ended_at !== null)
          throw err.invalidInput("session already ended", { session_id: input.session_id });
        const now = (ctx.now ?? Date.now)();
        const abs = traceAbsFor(deps, s, v, ctx, "write");
        appendTrace(abs, {
          ts: now,
          type: "session_end",
          session_id: s.id,
          ...(input.end_metadata ? { metadata: input.end_metadata } : {}),
        });
        endSession(ctx.db, s.id, now);
        deps.activeSessions?.clear(ctx.caller, s.id);
        return {
          session_id: s.id,
          ended_at: now,
          trace_path: s.trace_path,
          event_count: readTrace(abs).length,
          duration_ms: now - s.started_at,
        };
      },
    }),

    defineTool({
      name: "get_session_traces",
      domain: "knowledge",
      description:
        "Replay JSONL trace records for one session, or across a started-at date window, with optional tool filtering.",
      inputSchema: z
        .object({
          vault: VaultId,
          session_id: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          tool_filter: z.array(z.string()).optional(),
        })
        .merge(Pagination)
        .strict(),
      outputSchema: GetSessionTracesOutput,
      requiredScopes: ["read:workspace"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const fromMs = parseIso(input.from, "from");
        const toMs = parseIso(input.to, "to");
        // Element type states what every row actually has: a trace record PLUS the session it came
        // from. TraceRecord alone leaves session_id to the index signature (i.e. `unknown`), which
        // the output schema rightly refuses.
        const records: Array<TraceRecord & { session_id: string }> = [];
        const collect = (s: SessionRow): void => {
          for (const rec of readTrace(traceAbsFor(deps, s, v, ctx, "read"))) {
            // THE-736: captured ARGUMENTS never leave through this tool. Two facts make that
            // necessary rather than cautious:
            //   * TraceRecordOutput is `.catchall(z.unknown())`, so a new field flows to the
            //     client by DEFAULT — omission has to be an act, not an oversight;
            //   * this tool does not filter by principal. It is `read:workspace`-scoped and
            //     returns any session's records in the vault, so returning captured note bodies
            //     would be cross-principal content disclosure — the same class THE-737 closed at
            //     the file level, arriving through a different door.
            // Replay (THE-645 item 3) reads the trace FILE server-side and does not need this.
            const { args: _args, args_scan: _scan, ...safe } = rec;
            // `session_id` LAST, not first: TraceRecord carries an index signature, so a record
            // that happened to contain its own `session_id` key would otherwise overwrite the
            // authoritative one with whatever the file said.
            records.push({ ...safe, session_id: s.id });
          }
        };
        if (input.session_id) {
          const s = getSession(ctx.db, input.session_id);
          if (!s || s.vault_id !== v.id)
            throw err.invalidInput("session not found", { session_id: input.session_id });
          collect(s);
        } else {
          for (const s of sessionsInWindow(ctx.db, v.id, fromMs, toMs)) collect(s);
        }

        const tools = input.tool_filter ? new Set(input.tool_filter) : undefined;
        const filtered = records.filter((r) => {
          if (fromMs !== undefined && typeof r.ts === "number" && r.ts < fromMs) return false;
          if (toMs !== undefined && typeof r.ts === "number" && r.ts > toMs) return false;
          if (tools) return typeof r.tool === "string" && tools.has(r.tool);
          return true;
        });
        filtered.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

        const limit = input.limit ?? 100;
        const start = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
        const page = filtered.slice(start, start + limit);
        const next = start + limit < filtered.length ? String(start + limit) : null;
        return { vault: v.id, items: page, next_cursor: next, total_returned: page.length };
      },
    }),
  ];
}
