// THE-647 item 2: a JWT `persona` claim resolves end to end over the real HTTP transport — the
// same "one shared handler, two callers" harness http-caller-isolation.test.ts uses, extended
// with a `personas` config and tokens carrying a `persona` claim instead of raw scopes/vault.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
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

// Accepts the raw (pre-default) shape ServerConfigSchema.parse below normalizes — same reason
// visibility.test.ts's `cfg()` helper parses through the schema rather than hand-typing the
// fully-defaulted ToolVisibilityConfig output shape.
async function boot(personas?: Record<string, unknown>) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  registry.register({
    name: "whoami",
    description: "test-only: echoes the caller context it was dispatched with",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: (_a: unknown, ctx: CallerContext) => ({
      caller: ctx.caller,
      vaultId: ctx.vaultId,
      scopes: [...ctx.grantedScopes],
      persona: ctx.persona ?? null,
      toolVisibilityHidden: ctx.toolVisibility?.hidden ?? null,
    }),
  } as never);
  const parsed = ServerConfigSchema.parse({
    vaults: [
      { id: "main", path: "/tmp/main" },
      { id: "scratch", path: "/tmp/scratch" },
    ],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
    ...(personas ? { personas } : {}),
  });
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth: parsed.auth,
    db,
    vaultId: "main",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    personas: parsed.personas,
  });
}

async function tokenFor(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ aud: "http://test", iat: now, exp: now + 600, ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

async function whoami(port: number, jwt: string): Promise<{ status: number; body: any }> {
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
  return { status: res.status, body: body.result?.structuredContent ?? body };
}

const PERSONAS = {
  researcher: { vaults: ["main"], scopes: ["read:notes"] },
  author: {
    vaults: ["main", "scratch"],
    scopes: ["read:notes", "write:notes"],
    toolVisibility: { hidden: ["knowledge_challenge"] },
  },
};

describe("persona claim over HTTP (THE-647 item 2)", () => {
  it("a token's own vault claim outside the persona's vaults is refused — never widened to it anyway", async () => {
    const handle = await boot(PERSONAS);
    try {
      // researcher is bound to ["main"] only; this token asks for "scratch" and carries wider
      // raw scopes too — both must be irrelevant to the verdict, which is refusal, not a
      // silent substitution of the persona's default vault while keeping the raw scopes.
      const token = await tokenFor({
        sub: "agent-1",
        persona: "researcher",
        scopes: ["read:notes", "write:notes", "admin:everything"],
        vault: "scratch",
      });
      const { status } = await whoami(handle.port, token);
      expect(status).toBe(401);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("a persona token with no vault claim resolves to the persona's default (first) vault", async () => {
    const handle = await boot(PERSONAS);
    try {
      const token = await tokenFor({
        sub: "agent-1b",
        persona: "researcher",
        scopes: ["admin:everything"], // discarded — the persona's scopes win
      });
      const { status, body } = await whoami(handle.port, token);
      expect(status).toBe(200);
      expect(body.caller).toBe("agent-1b");
      expect(body.vaultId).toBe("main");
      expect(body.scopes).toEqual(["read:notes"]);
      expect(body.persona).toBe("researcher");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("resolves scopes/vault/persona correctly when the token's vault matches the persona", async () => {
    const handle = await boot(PERSONAS);
    try {
      const token = await tokenFor({
        sub: "agent-2",
        persona: "author",
        scopes: ["admin:everything"], // must be discarded entirely
        vault: "scratch",
      });
      const { status, body } = await whoami(handle.port, token);
      expect(status).toBe(200);
      expect(body.persona).toBe("author");
      expect(body.vaultId).toBe("scratch");
      expect(body.scopes.sort()).toEqual(["read:notes", "write:notes"]);
      expect(body.toolVisibilityHidden).toEqual(["knowledge_challenge"]);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("an unrecognised persona name is refused (fails closed, not a fallback to raw scopes)", async () => {
    const handle = await boot(PERSONAS);
    try {
      const token = await tokenFor({
        sub: "agent-3",
        persona: "ghost",
        scopes: ["read:notes"],
      });
      const { status } = await whoami(handle.port, token);
      expect(status).toBe(401);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("a persona claim with personas unconfigured is refused, not silently ignored", async () => {
    const handle = await boot(undefined);
    try {
      const token = await tokenFor({ sub: "agent-4", persona: "researcher", scopes: ["*"] });
      const { status } = await whoami(handle.port, token);
      expect(status).toBe(401);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("a token with no persona claim is unaffected by a configured personas block", async () => {
    const handle = await boot(PERSONAS);
    try {
      const token = await tokenFor({ sub: "agent-5", scopes: ["read:notes"], vault: "main" });
      const { status, body } = await whoami(handle.port, token);
      expect(status).toBe(200);
      expect(body.caller).toBe("agent-5");
      expect(body.scopes).toEqual(["read:notes"]);
      expect(body.persona).toBeNull();
    } finally {
      await handle.close();
    }
  }, 30_000);
});
