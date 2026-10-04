// Authorization-server design v2, section 4.2 and owner decision 4 (slice S2): for a token signed
// by an `as`-purpose registry key, the effective scopes of a persona are persona.scopes INTERSECT
// the token's `scope`. It only ever removes. A hand-minted persona token (HS256, or an asymmetric
// `mint` key) keeps today's rule: the persona's scopes REPLACE the token's.
import { randomUUID } from "node:crypto";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import * as personaModule from "../src/auth/persona";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey, importSigningKey } from "../src/auth/signing-keys";
import { createTokenVerifier } from "../src/auth/verifier";
import { provisionAuthDb, provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";
const AS_ISS = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

describe("narrowToTokenScopes", () => {
  const narrow = (persona: string[], token: string[]): string[] =>
    [
      ...(
        personaModule as unknown as {
          narrowToTokenScopes(p: Set<string>, t: Set<string>): Set<string>;
        }
      ).narrowToTokenScopes(new Set(persona), new Set(token)),
    ].sort();

  it("keeps only what both name", () => {
    expect(narrow(["read:notes", "write:notes"], ["read:notes"])).toEqual(["read:notes"]);
  });

  it("never adds: a wider token leaves the persona's scopes as they are", () => {
    expect(narrow(["read:notes"], ["*"])).toEqual(["read:notes"]);
    expect(narrow(["read:notes"], ["read:*", "write:notes"])).toEqual(["read:notes"]);
  });

  it("a scope the token has but the persona lacks is not granted", () => {
    expect(narrow(["read:notes"], ["write:notes"])).toEqual([]);
    expect(narrow(["read:notes"], [])).toEqual([]);
  });

  it("honours family wildcards on either side, keeping the narrower scope", () => {
    expect(narrow(["read:*"], ["read:notes"])).toEqual(["read:notes"]);
    expect(narrow(["read:notes", "write:notes"], ["read:*"])).toEqual(["read:notes"]);
    expect(narrow(["*"], ["read:notes"])).toEqual(["read:notes"]);
  });
});

async function boot(personas: Record<string, unknown>) {
  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const dir = makeTempDir("auth-purpose-persona-");
  dirs.push(dir);
  const authRegistry = createAuthRegistry(authDb, {
    configSecret: SECRET,
    keysDir: authKeysDir(dir),
  });
  const generated = await generateSigningKey("ES256");
  authRegistry.rotateKey({ purpose: "as", alg: "ES256", generated } as never);
  const verifier = createTokenVerifier({
    secret: SECRET,
    registry: authRegistry,
    audience: RESOURCE,
    asIssuer: AS_ISS,
    resource: RESOURCE,
  } as never);

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
      scopes: [...ctx.grantedScopes].sort(),
      persona: ctx.persona ?? null,
    }),
  } as never);
  registry.register({
    name: "writer",
    description: "test-only: needs write:notes, to see a narrowed grant refuse a real call",
    inputSchema: z.object({}),
    requiredScopes: ["write:notes"],
    handler: () => ({ wrote: true }),
  } as never);
  const parsed = ServerConfigSchema.parse({
    vaults: [
      { id: "main", path: "/tmp/main" },
      { id: "scratch", path: "/tmp/scratch" },
    ],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: RESOURCE, tokenTtlSeconds: 3600 },
    personas,
  });
  const handle = await startHttp({
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
    authRegistry,
    verifier,
  });
  const asToken = async (claims: Record<string, unknown>) => {
    const k = authRegistry.signingKey({ purpose: "as" } as never);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: AS_ISS,
      sub: "user-1",
      aud: RESOURCE,
      client_id: "client-1",
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: k.kid, typ: "at+jwt" })
      .sign(await importSigningKey("ES256", k.secret));
  };
  return { handle, asToken };
}

const hs256 = (claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ aud: RESOURCE, iat: now, exp: now + 600, ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
};

async function whoami(
  port: number,
  jwt: string,
  tool = "whoami",
): Promise<{ status: number; body: any; raw: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": tool,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
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
  return { status: res.status, body: body.result?.structuredContent ?? body, raw: body };
}

const PERSONAS = {
  author: { vaults: ["main", "scratch"], scopes: ["read:notes", "write:notes"] },
};

describe("persona over HTTP: `as` tokens narrow, hand-minted tokens replace", () => {
  it(
    "an `as` token's scope narrows its persona to the intersection",
    async () => {
      const { handle, asToken } = await boot(PERSONAS);
      try {
        const { status, body } = await whoami(
          handle.port,
          await asToken({ persona: "author", scope: "read:notes" }),
        );
        expect(status).toBe(200);
        expect(body.scopes).toEqual(["read:notes"]);
        expect(body.persona).toBe("author");
        expect(body.vaultId).toBe("main");
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "an `as` token can never widen its persona: scopes the persona lacks are dropped",
    async () => {
      const { handle, asToken } = await boot(PERSONAS);
      try {
        const { status, body } = await whoami(
          handle.port,
          await asToken({ persona: "author", scope: "read:notes write:notes admin:everything" }),
        );
        expect(status).toBe(200);
        expect(body.scopes).toEqual(["read:notes", "write:notes"]);
        const none = await whoami(
          handle.port,
          await asToken({ persona: "author", scope: "admin:everything" }),
        );
        expect(none.status).toBe(200);
        expect(none.body.scopes).toEqual([]);
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "a call needing a scope outside the `as` token's scope is refused; the same call on a mint token is not",
    async () => {
      const { handle, asToken } = await boot(PERSONAS);
      try {
        // The persona holds write:notes, the token's scope does not: the narrowed grant refuses it.
        const narrowed = await whoami(
          handle.port,
          await asToken({ persona: "author", scope: "read:notes" }),
          "writer",
        );
        expect(JSON.stringify(narrowed.raw)).not.toContain('"wrote":true');
        expect(JSON.stringify(narrowed.raw)).toMatch(/forbidden|scope|denied/i);
        // The `as` token that does carry write:notes may call it.
        const allowed = await whoami(
          handle.port,
          await asToken({ persona: "author", scope: "read:notes write:notes" }),
          "writer",
        );
        expect(JSON.stringify(allowed.raw)).toContain('"wrote":true');
        // A hand-minted persona token keeps the persona's scopes, whatever it names itself.
        const minted = await whoami(
          handle.port,
          await hs256({ sub: "agent-1", persona: "author", scopes: ["read:notes"] }),
          "writer",
        );
        expect(JSON.stringify(minted.raw)).toContain('"wrote":true');
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "an `as` token with no persona carries its own scope, unchanged",
    async () => {
      const { handle, asToken } = await boot(PERSONAS);
      try {
        const { body } = await whoami(handle.port, await asToken({ scope: "read:notes" }));
        expect(body.scopes).toEqual(["read:notes"]);
        expect(body.persona).toBeNull();
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "a hand-minted persona token keeps today's rule: the persona's scopes replace the token's",
    async () => {
      const { handle } = await boot(PERSONAS);
      try {
        const { status, body } = await whoami(
          handle.port,
          await hs256({ sub: "agent-1", persona: "author", scopes: ["read:notes"] }),
        );
        expect(status).toBe(200);
        expect(body.scopes).toEqual(["read:notes", "write:notes"]);
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "an `as` token naming an unknown persona is still refused",
    async () => {
      const { handle, asToken } = await boot(PERSONAS);
      try {
        const { status } = await whoami(
          handle.port,
          await asToken({ persona: "ghost", scope: "read:notes" }),
        );
        expect(status).toBe(401);
      } finally {
        await handle.close();
      }
    },
    stallTimeout(30_000),
  );
});
