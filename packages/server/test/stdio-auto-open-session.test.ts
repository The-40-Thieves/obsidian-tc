// GH #1457 proposal 2: `sessions.autoOpen` opens a server-side workspace session on stdio as well
// as HTTP. The stdio context is process-local and always principal "stdio", so the open happens on
// the first call that touches a vault (tools/call, resources/read) and never on the connect-time
// list calls, which clients make on every connect and would otherwise leave one empty session each.
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { closeStdioOpened, stdioContext } from "../src/runtime/stdio-context";
import { connectStdio } from "../src/transports/stdio";
import { VaultRegistry } from "../src/vault/registry";
import { autoOpenSession } from "../src/workspace/auto-open";
import {
  ActiveSessionTracker,
  cacheTraceRelPath,
  DEFAULT_TRACE_FOLDER,
  genSessionId,
  insertSession,
  markInFlight,
} from "../src/workspace/sessions";
import { waitFor } from "./git-sync-test-helpers";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmTemp(d);
});

interface Harness {
  db: Database;
  tracker: ActiveSessionTracker;
  closeOpened: (now: number) => number;
  request: (method: string, params?: object) => Promise<Record<string, any>>;
  close: () => Promise<void>;
}

/** The real stdio server over in-memory streams: `connectStdio` plus JSON-RPC lines, initialized. */
async function harness(autoOpen: boolean): Promise<Harness> {
  const root = makeTempDir("obtc-stdio-autoopen-");
  tmpRoots.push(root);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const tracker = new ActiveSessionTracker();
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    description: "test-only: reports the session the context carries",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: (_a: unknown, ctx: CallerContext) => ({ session_id: ctx.sessionId ?? null }),
  } as never);
  const context = stdioContext({
    activeSessions: tracker,
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    config: { sessions: { autoOpen, windowSeconds: 1800 } },
    defaultVaultId: "main",
  });
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    vaultRegistry: new VaultRegistry([{ id: "main", path: root }]),
  });

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies = new Map<number, Record<string, any>>();
  let pending = "";
  stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const msg = JSON.parse(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  const transport = await connectStdio(server, { stdin, stdout });
  let nextId = 1;
  const request = async (method: string, params: object = {}) => {
    const id = nextId++;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await waitFor(() => replies.has(id), 4_000).catch(() => {
      throw new Error(`no stdio reply for ${method}`);
    });
    return replies.get(id) as Record<string, any>;
  };
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "1" },
  });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    db,
    tracker,
    closeOpened: (now) => closeStdioOpened(db, now),
    request,
    close: () => transport.close(),
  };
}

const probe = { name: "probe", arguments: {} };

function rows(
  db: Database,
): { id: string; caller: string | null; principal: string | null; ended_at: number | null }[] {
  return db
    .prepare("SELECT id, caller, principal, ended_at FROM workspace_sessions ORDER BY rowid")
    .all() as never;
}

function endedAt(db: Database, id: string): number | null {
  const row = db.prepare("SELECT ended_at FROM workspace_sessions WHERE id = ?").get(id) as {
    ended_at: number | null;
  };
  return row.ended_at;
}

describe("stdio sessions.autoOpen opens a server session on the first vault call", () => {
  it(
    "opens one implicit session on the first tools/call and reuses it on the next",
    async () => {
      const h = await harness(true);
      try {
        const first = await h.request("tools/call", probe);
        const second = await h.request("tools/call", probe);
        const all = rows(h.db);
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ caller: null, principal: "stdio", ended_at: null });
        expect(first.result.structuredContent).toEqual({ session_id: all[0]?.id });
        expect(second.result.structuredContent).toEqual({ session_id: all[0]?.id });
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "opens NO row for the connect-time calls (tools/list, resources/list, prompts/list, prompts/get)",
    async () => {
      const h = await harness(true);
      try {
        await h.request("tools/list", {});
        await h.request("resources/list", {});
        await h.request("prompts/list", {});
        await h.request("prompts/get", { name: "no-such-prompt" });
        expect(rows(h.db)).toHaveLength(0);
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "opens on resources/read as well as on a tool call",
    async () => {
      const h = await harness(true);
      try {
        await h.request("resources/read", { uri: "obsidian-tc://catalog" });
        const all = rows(h.db);
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ caller: null, principal: "stdio", ended_at: null });
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "autoOpen off (the default) opens no row on a tools/call",
    async () => {
      const h = await harness(false);
      try {
        const res = await h.request("tools/call", probe);
        expect(rows(h.db)).toHaveLength(0);
        expect(res.result.structuredContent).toEqual({ session_id: null });
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "opens a fresh session once the sweep has closed the tracked one",
    async () => {
      const h = await harness(true);
      try {
        await h.request("tools/call", probe);
        const first = rows(h.db)[0]?.id as string;
        h.db
          .prepare("UPDATE workspace_sessions SET ended_at = ? WHERE id = ?")
          .run(Date.now(), first);

        const second = await h.request("tools/call", probe);
        const all = rows(h.db);
        expect(all).toHaveLength(2);
        const fresh = all[1]?.id as string;
        expect(fresh).not.toBe(first);
        expect(second.result.structuredContent).toEqual({ session_id: fresh });
        expect(h.tracker.get("stdio")?.sessionId).toBe(fresh);
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "closeOpened closes the row this process opened and leaves an explicit session open",
    async () => {
      const h = await harness(true);
      try {
        await h.request("tools/call", probe);
        const implicit = rows(h.db)[0]?.id as string;

        // What start_session does (tools/m5/session-tools.ts): a caller-declared row, tracked under
        // the caller. The tracker then points at it, so the next call attaches to it, not a new one.
        const explicit = genSessionId();
        insertSession(h.db, {
          id: explicit,
          vaultId: "main",
          caller: "agent-a",
          startedAt: Date.now(),
          tracePath: cacheTraceRelPath(explicit),
          principal: "stdio",
        });
        h.tracker.set("stdio", explicit, "main");
        const res = await h.request("tools/call", probe);
        expect(res.result.structuredContent).toEqual({ session_id: explicit });

        expect(h.closeOpened(Date.now())).toBe(1);
        expect(endedAt(h.db, implicit)).not.toBeNull();
        expect(endedAt(h.db, explicit)).toBeNull();
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "closeOpened skips a session that has a call in flight",
    async () => {
      const h = await harness(true);
      try {
        await h.request("tools/call", probe);
        const id = rows(h.db)[0]?.id as string;
        const release = markInFlight(id);
        try {
          expect(h.closeOpened(Date.now())).toBe(0);
          expect(endedAt(h.db, id)).toBeNull();
        } finally {
          release();
        }
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "closeOpened keeps closing the other rows when one endSession throws",
    async () => {
      const h = await harness(true);
      try {
        await h.request("tools/call", probe);
        const first = rows(h.db)[0]?.id as string;
        h.db
          .prepare("UPDATE workspace_sessions SET ended_at = ? WHERE id = ?")
          .run(Date.now(), first);
        await h.request("tools/call", probe);
        const second = rows(h.db)[1]?.id as string;

        // Re-open the first row, so this process still holds two open rows, and it is the one
        // closeOpened reaches first. A trigger makes its UPDATE fail, the way SQLITE_BUSY would.
        h.db.prepare("UPDATE workspace_sessions SET ended_at = NULL WHERE id = ?").run(first);
        h.db
          .prepare(
            `CREATE TRIGGER fail_close BEFORE UPDATE OF ended_at ON workspace_sessions
             WHEN OLD.id = '${first}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
          )
          .run();

        expect(h.closeOpened(Date.now())).toBe(1);
        expect(endedAt(h.db, second)).not.toBeNull();
        expect(endedAt(h.db, first)).toBeNull();
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );
});

describe("autoOpenSession: the open path both transports share", () => {
  it("opens nothing when autoOpen is off, or the principal is null, undefined or empty", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const base = { vaultId: "main", traceFolder: DEFAULT_TRACE_FOLDER, now: 1 };
    expect(autoOpenSession(db, { ...base, autoOpen: false, principal: "stdio" })).toBeUndefined();
    expect(autoOpenSession(db, { ...base, autoOpen: true, principal: null })).toBeUndefined();
    expect(autoOpenSession(db, { ...base, autoOpen: true, principal: undefined })).toBeUndefined();
    expect(autoOpenSession(db, { ...base, autoOpen: true, principal: "" })).toBeUndefined();
    const count = db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get() as { n: number };
    expect(count.n).toBe(0);

    const opened = autoOpenSession(db, { ...base, autoOpen: true, principal: "stdio" });
    expect(opened?.vaultId).toBe("main");
    expect(typeof opened?.sessionId).toBe("string");
    db.close?.();
  });
});
