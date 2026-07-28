// THE-583: the property that makes ONE long-lived MCP handler safe to share between callers.
//
// The handler used to be built per request, and the comment saying why was correct: the caller
// context closed over that request's verified identity, so a shared handler would have leaked one
// caller's authorization into another's. That is also exactly what made a long-lived
// `subscriptions/listen` stream impossible — the handler serving it was closed the moment the
// request that created it returned.
//
// The handler is now the app's, and the isolation comes from a different mechanism: the SDK invokes
// its factory once per SERVING UNIT (one HTTP request) and hands it that request's pass-through
// `authInfo`. Mechanism swaps are exactly where a security property goes missing quietly — the
// server still answers, every existing test still passes, and the leak is only visible if you drive
// two DIFFERENT callers through the SAME handler and compare. So that is what this does.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

/** Records the context each call was dispatched with, so leakage is directly observable. */
const seen: CallerContext[] = [];

async function boot() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  registry.register({
    name: "whoami",
    description: "test-only: echoes the caller context it was dispatched with",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: (_a: unknown, ctx: CallerContext) => {
      seen.push(ctx);
      return { caller: ctx.caller, vaultId: ctx.vaultId, scopes: [...ctx.grantedScopes] };
    },
  } as never);
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [
      { id: "alpha", path: "/tmp/alpha" },
      { id: "beta", path: "/tmp/beta" },
    ],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "alpha",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
}

async function tokenFor(sub: string, scopes: string[], vault?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub,
    scopes,
    aud: "http://test",
    iat: now,
    exp: now + 600,
    ...(vault ? { vault } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

async function whoami(port: number, jwt: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": "whoami",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "whoami",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "iso", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text || "{}");
  return body.result?.structuredContent ?? body;
}

describe("one shared handler, two callers (THE-583)", () => {
  it("never lets one caller's identity, scopes or vault reach another's dispatch", async () => {
    seen.length = 0;
    const handle = await boot();
    try {
      const alpha = await tokenFor("agent-alpha", ["read:notes"], "alpha");
      const beta = await tokenFor("agent-beta", ["read:notes", "write:notes"], "beta");

      // Interleaved deliberately: a handler that memoised the first request's context would answer
      // the second correctly only by accident of ordering.
      const a1 = await whoami(handle.port, alpha);
      const b1 = await whoami(handle.port, beta);
      const a2 = await whoami(handle.port, alpha);

      expect(a1.caller).toBe("agent-alpha");
      expect(a1.vaultId).toBe("alpha");
      expect(a1.scopes).toEqual(["read:notes"]);

      expect(b1.caller).toBe("agent-beta");
      expect(b1.vaultId).toBe("beta");
      expect(b1.scopes).toEqual(["read:notes", "write:notes"]);

      // The re-entry is the one that catches a sticky context: alpha must NOT have acquired beta's
      // write scope or vault by having followed it through the same handler.
      expect(a2.caller).toBe("agent-alpha");
      expect(a2.vaultId).toBe("alpha");
      expect(a2.scopes).toEqual(["read:notes"]);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("gives every dispatch a DISTINCT context object, not a shared mutable one", async () => {
    // Same values could still be one object mutated in place, which would be a race under
    // concurrency even though the sequential assertions above pass.
    seen.length = 0;
    const handle = await boot();
    try {
      const alpha = await tokenFor("agent-alpha", ["read:notes"], "alpha");
      const beta = await tokenFor("agent-beta", ["write:notes"], "beta");
      await Promise.all([
        whoami(handle.port, alpha),
        whoami(handle.port, beta),
        whoami(handle.port, alpha),
      ]);
      expect(seen).toHaveLength(3);
      expect(new Set(seen.map((c) => c)).size).toBe(3);
      // And each still carries its own grant set — the concurrent case, which is where a shared
      // context object would actually bite.
      for (const ctx of seen) {
        if (ctx.caller === "agent-alpha") {
          expect([...ctx.grantedScopes]).toEqual(["read:notes"]);
          expect(ctx.vaultId).toBe("alpha");
        } else {
          expect([...ctx.grantedScopes]).toEqual(["write:notes"]);
          expect(ctx.vaultId).toBe("beta");
        }
      }
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("still rejects an unauthenticated request rather than minting a context", async () => {
    // contextFromAuthInfo throws when authInfo is absent. No path reaches it today, but the failure
    // mode if one ever did is `authenticated: true` for a caller nobody verified.
    const handle = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": "tools/call",
          "mcp-name": "whoami",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
