// Domain 23 — Workspace memory + JSONL traces (G2.1). Three tools over the SQLite
// workspace_sessions table plus an append-only JSONL trace file per session:
// start_session, end_session, get_session_traces. Traces are vault-relative (path-safe
// via resolveVaultPath, ACL-checked via enforcePathAcl) — overriding G2.3's cache_dir
// sketch to honor THE-181's "ACL-checked" requirement. Reads take read:workspace,
// mutations take write:workspace (write family — readOnly kill-switch applies, no
// execute HITL floor; spec hitl:never). The append contract (appendTrace) is what the
// ambient capture worker (THE-175) targets to add tool-invocation records over time.
import { Pagination, VaultId, err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { resolveVaultPath } from "../../vault/paths";
import {
  type SessionRow,
  type TraceRecord,
  appendTrace,
  endSession,
  genSessionId,
  getSession,
  insertSession,
  readTrace,
  sessionsInWindow,
  traceRelPath,
} from "../../workspace/sessions";
import { defineTool } from "../m1/define";
import { type M5Deps, traceFolderFor } from "./shared";

/** Parse an optional ISO-8601 date to epoch-ms; throws invalid_input on a bad value. */
function parseIso(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw err.invalidInput(`${field} is not a valid ISO date`, { [field]: value });
  return ms;
}

export function buildSessionTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "start_session",
      description:
        "Begin a workspace memory session: a SQLite row plus an append-only JSONL trace file.",
      inputSchema: z
        .object({
          vault: VaultId,
          caller: z.string().min(1),
          session_metadata: z.record(z.unknown()).optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      requiredScopes: ["write:workspace"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const now = (ctx.now ?? Date.now)();
        const id = genSessionId();
        const tracePath = traceRelPath(traceFolderFor(deps, v.id), id);
        const abs = resolveVaultPath(v.root, tracePath);
        enforcePathAcl(ctx.acl, "write", tracePath);
        insertSession(ctx.db, {
          id,
          vaultId: v.id,
          caller: input.caller,
          startedAt: now,
          tracePath,
          metadata: input.session_metadata,
        });
        appendTrace(abs, {
          ts: now,
          type: "session_start",
          session_id: id,
          caller: input.caller,
          ...(input.session_metadata ? { metadata: input.session_metadata } : {}),
        });
        return { session_id: id, vault: v.id, started_at: now, trace_path: tracePath };
      },
    }),

    defineTool({
      name: "end_session",
      description:
        "Finalize a workspace session, appending a session_end record to its JSONL trace.",
      inputSchema: z
        .object({
          vault: VaultId,
          session_id: z.string().min(1),
          end_metadata: z.record(z.unknown()).optional(),
        })
        .strict(),
      requiredScopes: ["write:workspace"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const s = getSession(ctx.db, input.session_id);
        if (!s || s.vault_id !== v.id)
          throw err.invalidInput("session not found", { session_id: input.session_id });
        if (s.ended_at !== null)
          throw err.invalidInput("session already ended", { session_id: input.session_id });
        const now = (ctx.now ?? Date.now)();
        const abs = resolveVaultPath(v.root, s.trace_path);
        enforcePathAcl(ctx.acl, "write", s.trace_path);
        appendTrace(abs, {
          ts: now,
          type: "session_end",
          session_id: s.id,
          ...(input.end_metadata ? { metadata: input.end_metadata } : {}),
        });
        endSession(ctx.db, s.id, now);
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
      requiredScopes: ["read:workspace"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const fromMs = parseIso(input.from, "from");
        const toMs = parseIso(input.to, "to");
        const records: TraceRecord[] = [];
        const collect = (s: SessionRow): void => {
          enforcePathAcl(ctx.acl, "read", s.trace_path);
          for (const rec of readTrace(resolveVaultPath(v.root, s.trace_path)))
            records.push({ session_id: s.id, ...rec });
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
