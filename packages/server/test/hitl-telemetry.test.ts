// Confirmation-outcome telemetry (src/hitl-telemetry.ts): every way a gated call is confirmed or
// refused leaves ONE code-only `event_log` row, end to end over the real tools/call handler.
//
// Asserted against the event_log rows themselves, not against the recorder, because the wiring
// (which seam records, with which source/route) is the part that can silently not happen.
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { mintElicitForRaisedRequest } from "../src/cli/commands/elicit-mint";
import { runMaintenanceSweep } from "../src/db/maintenance";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, getDefaultElicitTtlSeconds } from "../src/elicit";
import { createElicitCodec } from "../src/elicit-request-state";
import {
  encodeHitlDetail,
  parseHitlDetail,
  readHitlConfirmationStats,
  recordHitlOutcome,
  sanitizeClientName,
} from "../src/hitl-telemetry";
import type { FacadeMode } from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { startHttp } from "../src/transports/http";
import { requireConfirmation } from "../src/vault/hitl";
import { openMemoryDb } from "./helpers";

const SECRET_PATH = "zz-private-folder/secret-plan-7431.md";

type Effect = { applied: number };
interface Row {
  event_type: string;
  status: string;
  error_code: string | null;
  tool_name: string | null;
  caller: string | null;
  args_hash: string | null;
}

function hitlRows(db: any): Row[] {
  return db
    .prepare(
      "SELECT event_type, status, error_code, tool_name, caller, args_hash FROM event_log WHERE event_type LIKE 'hitl_%' ORDER BY id",
    )
    .all() as Row[];
}
const codes = (db: any) => hitlRows(db).map((r) => `${r.event_type} ${r.error_code}`);

function dangerTool(effect: Effect, name = "danger_write"): ToolDefinition {
  return {
    name,
    description: "test-only destructive tool",
    inputSchema: z.strictObject({ path: z.string() }),
    requiredScopes: [],
    destructive: true,
    confirmationTargets: "none",
    handler: () => {
      effect.applied += 1;
      return { wrote: true };
    },
  } as unknown as ToolDefinition;
}

/** The handler-side gate shape (vault/hitl.ts requireConfirmation), not dispatch's own. */
function conditionalTool(effect: Effect): ToolDefinition {
  return {
    name: "write_note",
    description: "test-only write_note overwrite-gate shape",
    inputSchema: z.strictObject({ path: z.string(), overwriteNonEmpty: z.boolean().optional() }),
    requiredScopes: [],
    handler: (i: { path: string; overwriteNonEmpty?: boolean }, ctx: CallerContext) => {
      requireConfirmation(ctx, "write_note", i, i.overwriteNonEmpty === true, { path: i.path });
      effect.applied += 1;
      return { wrote: true };
    },
  } as unknown as ToolDefinition;
}

async function bootStdio(opts: { shim: boolean; facadeMode?: FacadeMode }) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const effect: Effect = { applied: 0 };
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registry.register(dangerTool(effect));
  registry.register(conditionalTool(effect));
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context: (signal?: AbortSignal): CallerContext => ({
      caller: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
      signal,
    }),
    visibility: { grantedScopes: new Set(["*"]) },
    ...(opts.facadeMode ? { facadeMode: opts.facadeMode } : {}),
    ...(opts.shim
      ? {
          elicitCodec: createElicitCodec(
            randomBytes(32).toString("hex"),
            getDefaultElicitTtlSeconds(),
          ),
          legacyElicitationShim: true,
        }
      : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  return { server, ct, db, effect };
}

const answering = (answer: Record<string, unknown>) => async (c: Client) =>
  c.setRequestHandler(ElicitRequestSchema, async () => answer as never);

async function roundTrip(
  answer: Record<string, unknown>,
  call: { name: string; arguments: Record<string, unknown> },
  facadeMode?: FacadeMode,
) {
  const { server, ct, db, effect } = await bootStdio({
    shim: true,
    ...(facadeMode ? { facadeMode } : {}),
  });
  const client = new Client(
    { name: "shim-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  );
  await answering(answer)(client);
  await client.connect(ct);
  const res = await client.callTool(call);
  await client.close();
  await server.close();
  return { res, db, effect };
}

const direct = { name: "danger_write", arguments: { path: SECRET_PATH } };

describe("form round trip (stdio legacy shim)", () => {
  it("accept: an offer row, then an accept row; the call completes", async () => {
    const { res, db, effect } = await roundTrip(
      { action: "accept", content: { approve: true } },
      direct,
    );
    expect(res.isError).toBeFalsy();
    expect(effect.applied).toBe(1);
    expect(codes(db)).toEqual([
      "hitl_offered form:direct:shim-test",
      "hitl_accept form:direct:shim-test",
    ]);
    const rows = hitlRows(db);
    expect(rows.map((r) => r.status)).toEqual(["skipped", "ok"]);
    expect(rows.every((r) => r.tool_name === "danger_write" && r.caller === "stdio")).toBe(true);
    // The offer and the answer share the call's args_hash — that is the episode pairing key.
    expect(rows[0]?.args_hash).toBeTruthy();
    expect(rows[0]?.args_hash).toBe(rows[1]?.args_hash);
  });

  it("decline: recorded, and the call had no side effect", async () => {
    const { res, db, effect } = await roundTrip({ action: "decline" }, direct);
    expect(res.isError).toBe(true);
    expect(effect.applied).toBe(0);
    expect(codes(db)).toEqual([
      "hitl_offered form:direct:shim-test",
      "hitl_decline form:direct:shim-test",
    ]);
  });

  it("cancel: recorded, and the call had no side effect", async () => {
    const { res, db, effect } = await roundTrip({ action: "cancel" }, direct);
    expect(res.isError).toBe(true);
    expect(effect.applied).toBe(0);
    expect(codes(db)).toEqual([
      "hitl_offered form:direct:shim-test",
      "hitl_cancel form:direct:shim-test",
    ]);
  });

  it("accept with approve:false is a decline, not an accept", async () => {
    const { db, effect } = await roundTrip(
      { action: "accept", content: { approve: false } },
      direct,
    );
    expect(effect.applied).toBe(0);
    expect(codes(db).at(-1)).toBe("hitl_decline form:direct:shim-test");
  });

  it("handler-side gate (write_note overwrite): accepted once, recorded once", async () => {
    const { db, effect } = await roundTrip(
      { action: "accept", content: { approve: true } },
      { name: "write_note", arguments: { path: SECRET_PATH, overwriteNonEmpty: true } },
    );
    expect(effect.applied).toBe(1);
    expect(codes(db).filter((c) => c.startsWith("hitl_accept"))).toEqual([
      "hitl_accept form:direct:shim-test",
    ]);
  });

  it("facade call_capability: same outcome codes, route is facade", async () => {
    const accepted = await roundTrip(
      { action: "accept", content: { approve: true } },
      { name: "call_capability", arguments: { name: "danger_write", args: { path: SECRET_PATH } } },
      "triad",
    );
    expect(accepted.effect.applied).toBe(1);
    expect(codes(accepted.db)).toEqual([
      "hitl_offered form:facade:shim-test",
      "hitl_accept form:facade:shim-test",
    ]);
    const declined = await roundTrip(
      { action: "decline" },
      { name: "call_capability", arguments: { name: "danger_write", args: { path: SECRET_PATH } } },
      "triad",
    );
    expect(declined.effect.applied).toBe(0);
    expect(codes(declined.db).at(-1)).toBe("hitl_decline form:facade:shim-test");
  });

  it("domain-verb facade: route is domain", async () => {
    const r = await roundTrip(
      { action: "accept", content: { approve: true } },
      { name: "notes", arguments: { action: "danger_write", args: { path: SECRET_PATH } } },
      "domain",
    );
    expect(r.effect.applied).toBe(1);
    expect(codes(r.db).at(-1)).toBe("hitl_accept form:domain:shim-test");
  });
});

describe("token path (CLI-minted)", () => {
  async function tokenFlow(
    call: (token?: string) => { name: string; arguments: Record<string, unknown> },
    facadeMode?: FacadeMode,
  ) {
    const { server, ct, db, effect } = await bootStdio({
      shim: false,
      ...(facadeMode ? { facadeMode } : {}),
    });
    const client = new Client({ name: "tok-client", version: "1" });
    await client.connect(ct);
    const need = await client.callTool(call());
    const details = (need.structuredContent as { details?: { args_hash?: string; tool?: string } })
      .details;
    expect((need.structuredContent as { code?: string }).code).toBe("elicit_required");
    // The headless path: `obsidian-tc elicit`'s own minting function, against the raised request.
    const token = mintElicitForRaisedRequest(db, {
      vaultId: "v1",
      toolName:
        call().arguments.name === undefined ? "danger_write" : String(call().arguments.name),
      argsHash: String(details?.args_hash),
      caller: "stdio",
      ttlSeconds: 300,
    });
    const res = await client.callTool(call(token));
    await client.close();
    await server.close();
    return { res, db, effect };
  }

  it("dispatch-gated tool: a redeemed token records accept/token", async () => {
    const { res, db, effect } = await tokenFlow((t) => ({
      name: "danger_write",
      arguments: { path: SECRET_PATH, ...(t ? { elicit_token: t } : {}) },
    }));
    expect(res.isError).toBeFalsy();
    expect(effect.applied).toBe(1);
    expect(codes(db)).toEqual(["hitl_accept token:direct:tok-client"]);
    // the mint itself is audited separately, untouched by this telemetry
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'elicit_minted'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("handler-side gate: a redeemed token records accept/token", async () => {
    const { db, effect } = await tokenFlow((t) => ({
      name: "write_note",
      arguments: { path: SECRET_PATH, overwriteNonEmpty: true, ...(t ? { elicit_token: t } : {}) },
    }));
    expect(effect.applied).toBe(1);
    expect(codes(db)).toEqual(["hitl_accept token:direct:tok-client"]);
  });

  it("through call_capability: route is facade", async () => {
    const { db, effect } = await tokenFlow(
      (t) => ({
        name: "call_capability",
        arguments: {
          name: "danger_write",
          args: { path: SECRET_PATH, ...(t ? { elicit_token: t } : {}) },
        },
      }),
      "triad",
    );
    expect(effect.applied).toBe(1);
    expect(codes(db)).toEqual(["hitl_accept token:facade:tok-client"]);
  });

  it("an unredeemed/refused call records nothing", async () => {
    const { server, ct, db, effect } = await bootStdio({ shim: false });
    const client = new Client({ name: "tok-client", version: "1" });
    await client.connect(ct);
    const res = await client.callTool({
      name: "danger_write",
      arguments: { path: SECRET_PATH, elicit_token: "not-a-real-token" },
    });
    expect(res.isError).toBe(true);
    expect(effect.applied).toBe(0);
    expect(hitlRows(db)).toEqual([]);
    await client.close();
    await server.close();
  });
});

describe("requestState (2026-era client-driven round trip, HTTP)", () => {
  const MODERN = "2026-07-28";
  const SECRET = "test-only-secret-not-a-real-credential-0123456789";
  const META = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "hitl-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  };

  async function boot() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const effect: Effect = { applied: 0 };
    const registry = new ToolRegistry({});
    registry.register({
      name: "danger_write",
      description: "test-only destructive tool",
      inputSchema: z.object({ vault: z.string(), path: z.string() }),
      requiredScopes: [],
      destructive: true,
      confirmationTargets: "none",
      handler: () => {
        effect.applied += 1;
        return { wrote: true };
      },
    } as never);
    const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
    }).auth;
    const h = await startHttp({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      auth,
      db,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
    });
    return { ...h, db, effect };
  }

  async function jwt(): Promise<string> {
    const { SignJWT } = await import("jose");
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: "agent-1",
      scopes: ["*"],
      aud: "http://test",
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));
  }

  async function call(
    port: number,
    token: string,
    requestState?: string,
    confirm?: Record<string, unknown>,
  ) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": "danger_write",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "danger_write",
          arguments: { vault: "v1", path: SECRET_PATH },
          _meta: META,
          ...(requestState ? { requestState } : {}),
          ...(confirm ? { inputResponses: { confirm } } : {}),
        },
      }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line ? line.slice(6) : text || "{}");
  }

  for (const [label, answer, outcome, applied] of [
    ["accept", { action: "accept", content: { approve: true } }, "hitl_accept", 1],
    ["decline", { action: "decline" }, "hitl_decline", 0],
    ["cancel", { action: "cancel" }, "hitl_cancel", 0],
  ] as const) {
    it(`${label}: offered then ${outcome}, source request_state, client recorded`, async () => {
      const h = await boot();
      try {
        const token = await jwt();
        const first = await call(h.port, token);
        const state = first.result.requestState as string;
        await call(h.port, token, state, answer);
        expect(h.effect.applied).toBe(applied);
        expect(codes(h.db)).toEqual([
          "hitl_offered request_state:direct:hitl-test",
          `${outcome} request_state:direct:hitl-test`,
        ]);
        expect(hitlRows(h.db).every((r) => r.caller === "agent-1")).toBe(true);
      } finally {
        await h.close();
      }
    }, 25_000);
  }
});

describe("what is recorded", () => {
  it("never contains arguments or content: only closed-vocabulary codes and hashes", async () => {
    const accepted = await roundTrip({ action: "accept", content: { approve: true } }, direct);
    const declined = await roundTrip(
      { action: "decline" },
      {
        name: "write_note",
        arguments: { path: SECRET_PATH, overwriteNonEmpty: true },
      },
    );
    for (const { db } of [accepted, declined]) {
      const everything = JSON.stringify(
        db.prepare("SELECT * FROM event_log WHERE event_type LIKE 'hitl_%'").all(),
      );
      expect(everything).not.toContain("secret-plan");
      expect(everything).not.toContain("zz-private-folder");
      expect(everything).not.toContain("approve");
      for (const r of hitlRows(db)) {
        expect(r.event_type).toMatch(/^hitl_(accept|decline|cancel|offered)$/);
        expect(r.error_code).toMatch(
          /^(form|request_state|token):(direct|facade|domain)(:[A-Za-z0-9._-]+)?$/,
        );
        expect(r.args_hash).toMatch(/^[0-9a-f]+$/);
      }
    }
  });

  it("client names are bounded and cannot forge the delimiter", () => {
    expect(sanitizeClientName("claude-code")).toBe("claude-code");
    expect(sanitizeClientName("a:b c\n")).toBe("a_b_c_");
    expect(sanitizeClientName("x".repeat(49))).toBeUndefined();
    expect(sanitizeClientName("")).toBeUndefined();
    expect(parseHitlDetail(encodeHitlDetail("token", "facade", "a:b"))).toEqual({
      source: "token",
      route: "facade",
      client: "a_b",
    });
    expect(parseHitlDetail("bogus:direct")).toBeNull();
    expect(parseHitlDetail(null)).toBeNull();
  });

  it("is swept with event_log retention", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const now = Date.now();
    const ctx = { db, vaultId: "v1", caller: "stdio" } as CallerContext;
    const at = (t: number) => () => t;
    recordHitlOutcome(
      ctx,
      { tool: "t", argsHash: "aa", outcome: "accept", source: "form" },
      at(now - 40 * 86_400_000),
    );
    recordHitlOutcome(
      ctx,
      { tool: "t", argsHash: "bb", outcome: "accept", source: "form" },
      at(now),
    );
    const counts = runMaintenanceSweep(db, {
      now: () => now,
      eventLogDays: 30,
      jobsCompleteDays: 7,
      jobsFailedDays: 30,
    });
    expect(counts.event_log).toBe(1);
    expect(hitlRows(db).map((r) => r.args_hash)).toEqual(["bb"]);
  });
});

describe("timeout is derived: an offer nobody answered within the TTL", () => {
  const ttlMs = 300_000;
  const now = 10_000_000_000;
  function seeded() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ctx = { db, vaultId: "v1", caller: "stdio" } as CallerContext;
    const at = (t: number) => () => t;
    const rec = (
      argsHash: string,
      outcome: "offered" | "accept" | "decline",
      source: "form" | "token",
      t: number,
    ) => recordHitlOutcome(ctx, { tool: "write_note", argsHash, outcome, source }, at(t));
    // unanswered, old enough -> timeout
    rec("h1", "offered", "form", now - 2 * ttlMs);
    // answered -> not a timeout
    rec("h2", "offered", "form", now - 2 * ttlMs);
    rec("h2", "decline", "form", now - 2 * ttlMs + 1000);
    // unanswered but still inside the TTL -> not yet a timeout
    rec("h3", "offered", "form", now - 1000);
    // offer timed out, human then used a token: the timeout still stands
    rec("h4", "offered", "form", now - 2 * ttlMs);
    rec("h4", "accept", "token", now - ttlMs);
    return db;
  }

  it("counts only expired, unanswered offers; a token redemption does not hide one", () => {
    const [s] = readHitlConfirmationStats(seeded(), { sinceMs: 0, nowMs: now, ttlMs });
    expect(s).toMatchObject({
      tool: "write_note",
      timeout: 2,
      decline: 1,
      accept: 1,
      tokenAccept: 1,
    });
  });
});
