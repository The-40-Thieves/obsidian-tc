// THE-726 slice 3: sessions the SERVER opens.
//
// #691 gave the HTTP transport the ability to CARRY a session; #692 proved that end to end. Neither
// makes a session EXIST — opening one is a deliberate act and no client performs it, which is what
// left `workspace_sessions` at 0 rows while three clients were actively calling tools.
//
// "Client adoption" was the recorded next step, but every client that would need changing is one we
// do not control, and the same reasoning that turned this from an adoption gap into a transport gap
// applies once more: a server-side answer exists. It is OFF by default, because correlation changes
// what this server retains about who read what (the epic's constraint 4).
//
// The property that makes the sweep safe is that a server-opened session is STRUCTURALLY
// distinguishable from a deliberate one: `start_session` requires `caller: z.string().min(1)`, so
// `caller IS NULL AND principal IS NOT NULL` is a shape only `openImplicitSession` can produce.
// That is asserted directly below rather than assumed, because the sweep's UPDATE keys on it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { runMaintenanceSweep } from "../src/db/maintenance";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildSessionTools } from "../src/tools/m5/session-tools";
import { startHttp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import {
  activeSessionFor,
  cacheTraceRelPath,
  closeStaleImplicitSessions,
  DEFAULT_TRACE_FOLDER,
  genSessionId,
  insertSession,
  openImplicitSession,
} from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

describe("the config default is the privacy posture", () => {
  it("defaults autoOpen to FALSE, so no deployment starts correlating without being told to", () => {
    // Constraint 4 of the epic: privacy is a design input, not a follow-up. Session correlation
    // changes what this server retains about who read what, so the safe value has to be the one a
    // config that says nothing gets. Asserted through a full parse rather than by reading the
    // schema literal, because `.prefault({})` on the block is what makes the key exist at all —
    // without it `config.sessions` is undefined and the wiring silently threads nothing.
    const parsed = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/tmp/x" }] });
    expect(parsed.sessions.autoOpen).toBe(false);
    expect(parsed.sessions.windowSeconds).toBe(1800);
  });
});

describe("openImplicitSession — the shape the sweep keys on", () => {
  it("writes principal but NEVER caller, which is what makes it distinguishable", () => {
    const db = freshDb();
    const opened = openImplicitSession(db, {
      principal: "alice",
      vaultId: "main",
      traceFolder: DEFAULT_TRACE_FOLDER,
      now: 1_000,
    });
    const row = db
      .prepare(
        "SELECT caller, principal, ended_at, trace_path, trace_store FROM workspace_sessions WHERE id = ?",
      )
      .get(opened.sessionId) as {
      caller: string | null;
      principal: string;
      ended_at: number | null;
      trace_path: string;
      trace_store: string;
    };
    expect(row.caller).toBeNull();
    expect(row.principal).toBe("alice");
    expect(row.ended_at).toBeNull();
    // The trace path must name THIS session. An earlier draft passed a pre-computed path built from
    // a separately-minted id, which stored a trace_path pointing at a session that never existed.
    // THE-737: cacheDir-relative now, not vault-relative — the assertion's INTENT (the path names
    // the id minted here) is unchanged; only the store moved.
    expect(row.trace_path).toBe(cacheTraceRelPath(opened.sessionId));
    expect(row.trace_store).toBe("cache");
    // The whole point of the move: nothing about this path is inside the vault any more.
    expect(row.trace_path.startsWith(".obsidian-tc")).toBe(false);
    // And it resolves, so the very next dispatch correlates to it.
    expect(activeSessionFor(db, "alice")).toStrictEqual({
      sessionId: opened.sessionId,
      vaultId: "main",
    });
    db.close?.();
  });
});

describe("closeStaleImplicitSessions — bounded window, deliberate sessions untouched", () => {
  it("closes a server-opened session once its window has elapsed, and not before", () => {
    const db = freshDb();
    const s = openImplicitSession(db, {
      principal: "alice",
      vaultId: "main",
      traceFolder: DEFAULT_TRACE_FOLDER,
      now: 0,
    });
    // Inside the window: nothing closes, and the session still resolves.
    expect(closeStaleImplicitSessions(db, { now: 1_000_000, windowSeconds: 1800 })).toBe(0);
    expect(activeSessionFor(db, "alice")?.sessionId).toBe(s.sessionId);

    // Past it: closed, and correlation stops. The next request opens a fresh one — a session is a
    // bounded activity window, not an idle timeout (see SessionsConfigSchema for the tradeoff).
    expect(closeStaleImplicitSessions(db, { now: 1_800_001, windowSeconds: 1800 })).toBe(1);
    expect(activeSessionFor(db, "alice")).toBeUndefined();
    db.close?.();
  });

  it("NEVER closes a session a client opened deliberately, however old", () => {
    const db = freshDb();
    // The deliberate shape: `caller` non-null, because start_session's schema requires it.
    const deliberate = genSessionId();
    insertSession(db, {
      id: deliberate,
      vaultId: "main",
      caller: "agent-alpha",
      startedAt: 0,
      tracePath: `${DEFAULT_TRACE_FOLDER}/${deliberate}.jsonl`,
      principal: "alice",
    });
    // A year later. Only end_session may decide a declared session is over; a sweep that closed it
    // would silently truncate a session its owner still considers open.
    expect(closeStaleImplicitSessions(db, { now: 31_536_000_000, windowSeconds: 1800 })).toBe(0);
    expect(activeSessionFor(db, "alice")?.sessionId).toBe(deliberate);
    db.close?.();
  });

  it("ignores a legacy row with neither caller nor principal", () => {
    const db = freshDb();
    // Pre-20260804_001 rows have principal NULL. They also often have caller NULL, so `caller IS
    // NULL` alone would sweep them — hence the `principal IS NOT NULL` half of the predicate.
    const legacy = genSessionId();
    insertSession(db, {
      id: legacy,
      vaultId: "main",
      caller: null,
      startedAt: 0,
      tracePath: `t/${legacy}.jsonl`,
      principal: null,
    });
    expect(closeStaleImplicitSessions(db, { now: 31_536_000_000, windowSeconds: 1800 })).toBe(0);
    expect(
      (
        db.prepare("SELECT ended_at FROM workspace_sessions WHERE id = ?").get(legacy) as {
          ended_at: number | null;
        }
      ).ended_at,
    ).toBeNull();
    db.close?.();
  });
});

describe("the maintenance sweep arm", () => {
  it("is INERT unless a window is configured, so autoOpen:false costs nothing", () => {
    const db = freshDb();
    openImplicitSession(db, {
      principal: "alice",
      vaultId: "main",
      traceFolder: DEFAULT_TRACE_FOLDER,
      now: 0,
    });
    const counts = runMaintenanceSweep(db, {
      now: () => 31_536_000_000,
      eventLogDays: 30,
      jobsCompleteDays: 7,
      jobsFailedDays: 30,
    });
    expect(counts.sessions_closed).toBe(0);
    expect(activeSessionFor(db, "alice")).toBeDefined();
    db.close?.();
  });

  it("closes through the sweep when a window IS configured", () => {
    const db = freshDb();
    openImplicitSession(db, {
      principal: "alice",
      vaultId: "main",
      traceFolder: DEFAULT_TRACE_FOLDER,
      now: 0,
    });
    const counts = runMaintenanceSweep(db, {
      now: () => 31_536_000_000,
      eventLogDays: 30,
      jobsCompleteDays: 7,
      jobsFailedDays: 30,
      sessionWindowSeconds: 1800,
    });
    expect(counts.sessions_closed).toBe(1);
    expect(activeSessionFor(db, "alice")).toBeUndefined();
    db.close?.();
  });
});

// --- end to end, over the real transport -----------------------------------------------------

interface Booted {
  port: number;
  db: Database;
  close: () => Promise<void>;
}

async function boot(sessions?: { autoOpen: boolean; windowSeconds: number }): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), "obtc-implicit-"));
  const db = freshDb();
  const vaultRegistry = new VaultRegistry([{ id: "main", path: root }]);
  const registry = new ToolRegistry();
  for (const tool of buildSessionTools({ vaultRegistry, cacheDir: root })) registry.register(tool);
  registry.register({
    name: "probe",
    description: "test-only: reports the session the context carries",
    inputSchema: z.object({}),
    requiredScopes: ["read:notes"],
    handler: (_a: unknown, ctx: CallerContext) => ({ session_id: ctx.sessionId ?? null }),
  } as never);
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "main", path: root }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "main",
    vaultRegistry,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    ...(sessions ? { sessions } : {}),
  });
  return {
    port: handle.port,
    db,
    close: async () => {
      await handle.close();
      db.close?.();
      rmTemp(root);
    },
  };
}

async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub,
    scopes: ["read:notes", "write:workspace"],
    aud: "http://test",
    iat: now,
    exp: now + 600,
    vault: "main",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

let nextId = 1;
async function call(
  port: number,
  jwt: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        // Required per-request envelope under 2026-07-28 — the server refuses without it.
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "implicit", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text || "{}");
  if (body.error) throw new Error(`${name} failed: ${JSON.stringify(body.error)}`);
  return body.result?.structuredContent ?? body.result;
}

describe("THE-726 slice 3 end-to-end: the server opens the session", () => {
  it("leaves session_id NULL when autoOpen is off — the default must change nothing", async () => {
    const h = await boot();
    try {
      const alice = await tokenFor("alice");
      expect((await call(h.port, alice, "probe")).session_id).toBeNull();
      expect(
        (h.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("opens one on the FIRST dispatch and reuses it on the next, without any client call", async () => {
    const h = await boot({ autoOpen: true, windowSeconds: 1800 });
    try {
      const alice = await tokenFor("alice");
      // The acceptance criterion this epic has been stuck on, reached with no client change at all.
      const first = (await call(h.port, alice, "probe")).session_id as string;
      expect(first).toMatch(/^sess_[0-9a-f]{24}$/);

      // Reused, not re-opened. A second row per request would make session_id useless as a
      // correlation key and would grow workspace_sessions without bound.
      const second = (await call(h.port, alice, "probe")).session_id;
      expect(second).toBe(first);
      expect(
        (h.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("keeps principals apart, so auto-opening cannot merge two callers", async () => {
    const h = await boot({ autoOpen: true, windowSeconds: 1800 });
    try {
      const a = (await call(h.port, await tokenFor("alice"), "probe")).session_id;
      const b = (await call(h.port, await tokenFor("bob"), "probe")).session_id;
      expect(a).not.toBe(b);
      expect(
        (h.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get() as { n: number }).n,
      ).toBe(2);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("yields to a session the client opens deliberately", async () => {
    const h = await boot({ autoOpen: true, windowSeconds: 1800 });
    try {
      const alice = await tokenFor("alice");
      const auto = (await call(h.port, alice, "probe")).session_id as string;

      // An explicit start_session is the more recent open session, so activeSessionFor prefers it.
      // No flag and no precedence rule is needed for that — "most recent open" already says it.
      const declared = (
        await call(h.port, alice, "start_session", { vault: "main", caller: "agent-alpha" })
      ).session_id as string;
      expect(declared).not.toBe(auto);
      expect((await call(h.port, alice, "probe")).session_id).toBe(declared);

      // And the sweep then closes only the abandoned auto session, never the declared one. `now` is
      // taken forward from the REAL clock, not a synthetic epoch: these rows were stamped by the
      // transport with Date.now(), so a small absolute `now` puts the cutoff decades before them and
      // the sweep correctly finds nothing — which would read here as the arm being broken.
      const past = Date.now() + 3_600_000;
      expect(closeStaleImplicitSessions(h.db, { now: past, windowSeconds: 1800 })).toBe(1);
      expect(
        (
          h.db.prepare("SELECT ended_at FROM workspace_sessions WHERE id = ?").get(declared) as {
            ended_at: number | null;
          }
        ).ended_at,
      ).toBeNull();
    } finally {
      await h.close();
    }
  }, 30_000);
});
