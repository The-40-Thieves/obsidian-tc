// THE-726, the COMPOSITION half. `active-session-resolution.test.ts` proves `activeSessionFor`
// resolves correctly; this proves the whole chain actually joins up over a live HTTP request:
//
//     POST /mcp start_session  ->  workspace_sessions row with principal = the JWT's sub
//     POST /mcp <any tool>     ->  contextFromAuthInfo -> activeSessionFor -> ctx.sessionId
//                              ->  createRetrievalLogger -> chunk_retrievals.session_id
//
// This test exists because the entire epic exists: every piece of that chain was individually
// present and individually correct, and `session_id` was still NULL on 100% of live rows, because
// nothing had ever asserted the pieces were CONNECTED on the transport production uses. A unit test
// per link would have stayed green through the whole outage — `transports/http.ts` contained the
// string "sessionId" zero times and no test noticed. So the assertions here are deliberately made
// against the stored row rather than against `ctx`: the row is the artifact that was empty.
//
// The in-memory `ActiveSessionTracker` is deliberately NOT wired into these tools. It is the
// mechanism that made stdio work and HTTP not work, and leaving it out means a pass here can only
// come from the durable SQLite path.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { createRetrievalLogger } from "../src/experiential/log";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildSessionTools } from "../src/tools/m5/session-tools";
import { startHttp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

const readMigration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: readMigration(file),
}));

interface Booted {
  port: number;
  close: () => Promise<void>;
  /** The experiential store the probe logs into — where chunk_retrievals lands. */
  edb: Database;
}

/**
 * A live server with the REAL session tools plus one probe tool.
 *
 * The probe stands in for a search surface and for nothing else: it takes `ctx.sessionId` and hands
 * it to the real `createRetrievalLogger`, exactly as `m2/search-tools.ts` and the four m7 knowledge
 * surfaces do (`sessionId: ctx.sessionId ?? null`). Standing in for the search is deliberate — the
 * claim under test is that a session reaches a dispatch, not that ranking works, and driving a real
 * index here would make an unrelated embedding failure look like a session regression.
 */
async function boot(): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), "obtc-http-sess-"));
  const agentsRoot = mkdtempSync(join(tmpdir(), "obtc-http-sess-agents-"));

  const db = openMemoryDb();
  provisionCacheDb(db);
  const edb = openMemoryDb();
  runMigrations(edb, EXP_CHAIN);
  const log = createRetrievalLogger(edb);

  const vaultRegistry = new VaultRegistry([
    { id: "main", path: root },
    { id: "agents", path: agentsRoot },
  ]);

  const registry = new ToolRegistry();
  // No `activeSessions` — see the file header. The durable path must carry this alone.
  for (const tool of buildSessionTools({ vaultRegistry, cacheDir: root })) registry.register(tool);
  registry.register({
    name: "probe_retrieval",
    description: "test-only: logs one retrieval hit under whatever session the context carries",
    inputSchema: z.object({}),
    requiredScopes: ["read:notes"],
    handler: (_args: unknown, ctx: CallerContext) => {
      log({
        queryText: "probe",
        surfaceType: "probe_retrieval",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: [{ chunkId: "c1", rank: 1 }],
      });
      return { session_id: ctx.sessionId ?? null };
    },
  } as never);

  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [
      { id: "main", path: root },
      { id: "agents", path: agentsRoot },
    ],
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
  });
  return {
    port: handle.port,
    edb,
    close: async () => {
      await handle.close();
      db.close?.();
      edb.close?.();
      // rmTemp, not rmSync: start_session leaves a real JSONL trace under each root, and Windows
      // refuses to delete a file whose handle is still open. Both roots go regardless of what
      // failed above — five boots leaking two dirs each is how a suite quietly fills a runner.
      rmTemp(root);
      rmTemp(agentsRoot);
    },
  };
}

async function tokenFor(sub: string, scopes: string[], vault: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scopes, aud: "http://test", iat: now, exp: now + 600, vault })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

let nextId = 1;

/** One real tools/call over the wire. Throws on a JSON-RPC error so a broken call cannot read as
 *  "no session" — the failure mode this whole ticket is about is a silent null. */
async function call(
  port: number,
  jwt: string,
  name: string,
  args: Record<string, unknown>,
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
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text || "{}");
  if (body.error) throw new Error(`${name} failed: ${JSON.stringify(body.error)}`);
  const result = body.result;
  if (result?.isError) throw new Error(`${name} returned isError: ${JSON.stringify(result)}`);
  return result?.structuredContent ?? result;
}

/** Every chunk_retrievals row the probe has written, oldest first. */
function loggedSessions(edb: Database): Array<string | null> {
  return (
    edb.prepare("SELECT session_id FROM chunk_retrievals ORDER BY rowid").all() as Array<{
      session_id: string | null;
    }>
  ).map((r) => r.session_id);
}

describe("THE-726 end-to-end: a dispatch over HTTP lands a non-NULL session_id", () => {
  it("correlates a retrieval to the session the SAME principal opened over the same transport", async () => {
    const h = await boot();
    try {
      // `sub` is the observed principal; `caller` below is the declared one. They differ on purpose
      // — if this test used the same string for both, it would pass identically against a resolver
      // keyed on the caller-supplied field, which is precisely the vulnerable implementation.
      const alice = await tokenFor("alice", ["write:workspace", "read:notes"], "main");

      // The baseline that made the bug invisible for months: before any session exists, the probe
      // logs a NULL. This assertion is what gives the next one meaning — without it, a resolver
      // that returned a constant would look like a fix.
      await call(h.port, alice, "probe_retrieval", {});
      expect(loggedSessions(h.edb)).toEqual([null]);

      const started = await call(h.port, alice, "start_session", {
        vault: "main",
        caller: "agent-alpha",
      });
      const sessionId = started.session_id as string;
      expect(sessionId).toMatch(/^sess_[0-9a-f]{24}$/);

      // The claim. A second, entirely independent HTTP request — new context, new handler serving
      // unit, nothing cached between them — carries the session, and the retrieval row records it.
      const probed = await call(h.port, alice, "probe_retrieval", {});
      expect(probed.session_id).toBe(sessionId);
      expect(loggedSessions(h.edb)).toEqual([null, sessionId]);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("does NOT hand one principal's session to another who merely declares its `caller`", async () => {
    const h = await boot();
    try {
      const alice = await tokenFor("alice", ["write:workspace", "read:notes"], "main");
      const mallory = await tokenFor("mallory", ["write:workspace", "read:notes"], "main");

      const started = await call(h.port, alice, "start_session", {
        vault: "main",
        caller: "agent-alpha",
      });
      const aliceSession = started.session_id as string;

      // mallory holds write:workspace legitimately. She declares alice's exact `caller` string,
      // which is free text on start_session's input and therefore hers to choose. Holding that scope
      // must not imply the right to read alice's retrieval correlation.
      const probed = await call(h.port, mallory, "probe_retrieval", {});
      expect(probed.session_id).toBeNull();

      // THE COLLISION, which is the assertion that actually pins the column choice. The two fields
      // live in different namespaces and nothing keeps them apart: `caller` is free text a client
      // picks (typically a role name — "agent-alpha", "claude-code"), while `principal` is a token
      // `sub` an issuer mints. A principal whose name happens to equal alice's declared string is
      // an ordinary accident, and under a resolver keyed on `caller` it silently inherits alice's
      // session. Asserted before mallory opens her own session so there is exactly one row bearing
      // this `caller` and the leak, if it happened, could only be alice's.
      const impostor = await tokenFor("agent-alpha", ["write:workspace", "read:notes"], "main");
      expect((await call(h.port, impostor, "probe_retrieval", {})).session_id).toBeNull();

      // And declaring it on her OWN session must not make that session alice's either.
      const mallorySession = (
        await call(h.port, mallory, "start_session", { vault: "main", caller: "agent-alpha" })
      ).session_id as string;
      const probedAgain = await call(h.port, mallory, "probe_retrieval", {});
      expect(probedAgain.session_id).toBe(mallorySession);
      expect(probedAgain.session_id).not.toBe(aliceSession);

      // alice is unaffected throughout.
      expect((await call(h.port, alice, "probe_retrieval", {})).session_id).toBe(aliceSession);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("stops correlating once the session is ended, on the next request", async () => {
    const h = await boot();
    try {
      const alice = await tokenFor("alice", ["write:workspace", "read:notes"], "main");
      const sessionId = (
        await call(h.port, alice, "start_session", { vault: "main", caller: "agent-alpha" })
      ).session_id as string;
      expect((await call(h.port, alice, "probe_retrieval", {})).session_id).toBe(sessionId);

      await call(h.port, alice, "end_session", { vault: "main", session_id: sessionId });

      // Resolution is per request, so the very next dispatch must already see it closed. A cached
      // context would keep correlating a dead session indefinitely.
      expect((await call(h.port, alice, "probe_retrieval", {})).session_id).toBeNull();
      expect(loggedSessions(h.edb)).toEqual([sessionId, null]);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("does not attach a session opened against a vault this token is not bound to", async () => {
    const h = await boot();
    try {
      // Same principal, two tokens. This is the case the vault match in contextFromAuthInfo exists
      // for: attaching `main`'s session to an `agents`-bound request would point its JSONL trace at
      // a vault the request cannot touch (THE-267 makes dispatch reject the vault argument, but the
      // session is attached by the transport, below that check).
      const onMain = await tokenFor("alice", ["write:workspace", "read:notes"], "main");
      const onAgents = await tokenFor("alice", ["write:workspace", "read:notes"], "agents");

      const mainSession = (
        await call(h.port, onMain, "start_session", { vault: "main", caller: "agent-alpha" })
      ).session_id as string;

      expect((await call(h.port, onAgents, "probe_retrieval", {})).session_id).toBeNull();
      expect((await call(h.port, onMain, "probe_retrieval", {})).session_id).toBe(mainSession);
    } finally {
      await h.close();
    }
  }, 30_000);

  it("keeps concurrent principals' sessions separate under interleaved dispatch", async () => {
    const h = await boot();
    try {
      const alice = await tokenFor("alice", ["write:workspace", "read:notes"], "main");
      const bob = await tokenFor("bob", ["write:workspace", "read:notes"], "main");
      const a = (
        await call(h.port, alice, "start_session", { vault: "main", caller: "shared-declaration" })
      ).session_id as string;
      const b = (
        await call(h.port, bob, "start_session", { vault: "main", caller: "shared-declaration" })
      ).session_id as string;
      expect(a).not.toBe(b);

      // Sequential assertions can pass on a resolver that memoises the first principal it saw;
      // concurrency is where that actually bites.
      const [pa, pb, pa2] = await Promise.all([
        call(h.port, alice, "probe_retrieval", {}),
        call(h.port, bob, "probe_retrieval", {}),
        call(h.port, alice, "probe_retrieval", {}),
      ]);
      expect(pa.session_id).toBe(a);
      expect(pb.session_id).toBe(b);
      expect(pa2.session_id).toBe(a);

      // Both declared the identical `caller`, so a row set that came out all-one-session would mean
      // the declaration won.
      expect(new Set(loggedSessions(h.edb))).toEqual(new Set([a, b]));
    } finally {
      await h.close();
    }
  }, 30_000);
});
