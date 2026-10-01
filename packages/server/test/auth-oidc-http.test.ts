// `auth.mode: "oidc"` over the real HTTP transport and /metrics: the edge stays undifferentiated,
// the identity feeds the SAME scope/vault/persona pipeline jwt mode uses (parity), and Protected
// Resource Metadata advertises the external issuer.

import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { createOidcVerifier } from "../src/auth/oidc";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMetricsApp } from "../src/metrics/endpoint";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { AUDIENCE, ISSUER, type MockIdp, publicResolver, startMockIdp } from "./oidc-mock-provider";
import { stallTimeout } from "./stall-timeouts";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";
const RESOURCE = "https://vault.example.com/mcp";
const PERSONAS = { researcher: { vaults: ["main"], scopes: ["read:notes"] } };

let idp: MockIdp;
beforeEach(async () => {
  idp = await startMockIdp();
});
afterEach(() => idp.close());

function whoamiRegistry() {
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
  return registry;
}

const CONFIG_BASE = {
  vaults: [
    { id: "main", path: "/tmp/main" },
    { id: "scratch", path: "/tmp/scratch" },
  ],
  personas: PERSONAS,
};

async function bootOidc(
  extraOidc: Record<string, unknown> = {},
  extraAuth: Record<string, unknown> = {},
  onAuthRejected?: (d: { reason: string }) => void,
) {
  const parsed = ServerConfigSchema.parse({
    ...CONFIG_BASE,
    auth: {
      mode: "oidc",
      tokenTtlSeconds: 3600,
      oidc: { issuer: ISSUER, audience: AUDIENCE, ...extraOidc },
      ...extraAuth,
    },
  });
  const verifier = await createOidcVerifier(parsed.auth, {
    fetch: idp.fetch,
    resolveHost: publicResolver,
  });
  return boot(parsed, { verifier, ...(onAuthRejected ? { onAuthRejected } : {}) });
}

async function bootJwt() {
  const parsed = ServerConfigSchema.parse({
    ...CONFIG_BASE,
    auth: { mode: "jwt", jwtSecret: SECRET, audience: AUDIENCE, tokenTtlSeconds: 3600 },
  });
  return boot(parsed, {});
}

async function boot(parsed: ServerConfig, extra: Record<string, unknown>) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: whoamiRegistry(),
    auth: parsed.auth,
    db,
    vaultId: "main",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    personas: parsed.personas,
    ...extra,
  } as Parameters<typeof startHttp>[0]);
}

async function whoami(
  port: number,
  token: string,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
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
          "io.modelcontextprotocol/clientInfo": { name: "oidc", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text || "{}");
  return { status: res.status, body: body.result?.structuredContent ?? body, headers: res.headers };
}

const hsToken = (claims: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ aud: AUDIENCE, iat: now, exp: now + 600, ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
};

describe("oidc over HTTP", () => {
  it(
    "a valid IdP token reaches the tool with its mapped identity",
    async () => {
      const h = await bootOidc();
      try {
        const r = await whoami(h.port, await idp.sign({ scope: "read:notes write:notes" }));
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          caller: "user-1",
          vaultId: "main",
          scopes: ["read:notes", "write:notes"],
          persona: null,
        });
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "every refusal is the same undifferentiated 401; the reason goes only to the operator sink",
    async () => {
      const seen: string[] = [];
      const h = await bootOidc({}, {}, (d) => seen.push(d.reason));
      try {
        const now = Math.floor(Date.now() / 1000);
        const bad = [
          await idp.sign({ exp: now - 600 }),
          await idp.sign({ iss: "https://evil.test" }),
          await idp.sign({ aud: "https://other.example.com" }),
          "not-a-jwt",
        ];
        const bodies: string[] = [];
        for (const t of bad) {
          const res = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${t}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
          });
          expect(res.status).toBe(401);
          bodies.push(await res.text());
        }
        expect(new Set(bodies).size).toBe(1);
        expect(seen.slice(0, 3)).toEqual(["token_expired", "issuer_mismatch", "audience_mismatch"]);
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  it(
    "no verifier (should never happen) refuses rather than admitting: fail closed",
    async () => {
      const parsed = ServerConfigSchema.parse({
        ...CONFIG_BASE,
        auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE } },
      });
      const h = await boot(parsed, {});
      try {
        const r = await whoami(h.port, await idp.sign());
        expect([401, 500]).toContain(r.status);
      } finally {
        await h.close();
      }
    },
    stallTimeout(30_000),
  );

  // The same claims, delivered by an HS256 jwt-mode server and by an IdP through oidc mode, must
  // resolve to the same caller context: scopes, vault binding and persona all flow into one
  // pipeline, so folder ACL / rule-scopes / vault binding downstream of it cannot differ.
  describe("parity with jwt mode", () => {
    const cases: {
      name: string;
      jwt: Record<string, unknown>;
      oidc: Record<string, unknown>;
      oidcCfg?: Record<string, unknown>;
    }[] = [
      {
        name: "plain scopes",
        jwt: { sub: "u", scopes: ["read:notes", "write:notes"] },
        oidc: { sub: "u", scope: "read:notes write:notes" },
      },
      {
        name: "vault binding",
        jwt: { sub: "u", scopes: ["read:notes"], vault: "scratch" },
        oidc: { sub: "u", scope: "read:notes", obsidian_vault: "scratch" },
        oidcCfg: { claimMapping: { vault: "obsidian_vault", allowedVaults: ["scratch"] } },
      },
      {
        name: "persona replaces scopes",
        jwt: { sub: "u", persona: "researcher", scopes: ["admin:everything"] },
        oidc: { sub: "u", obsidian_persona: "researcher", scope: "admin:everything" },
        oidcCfg: { claimMapping: { persona: "obsidian_persona", allowedPersonas: ["researcher"] } },
      },
      { name: "no scopes", jwt: { sub: "u" }, oidc: { sub: "u" } },
    ];
    for (const c of cases) {
      it(
        c.name,
        async () => {
          const j = await bootJwt();
          const o = await bootOidc(c.oidcCfg);
          try {
            const a = await whoami(j.port, await hsToken(c.jwt));
            const b = await whoami(
              o.port,
              await idp.sign(c.oidc, { unset: c.oidc.scope === undefined ? ["scope"] : [] }),
            );
            expect(b.status).toBe(a.status);
            expect(b.body).toEqual(a.body);
            expect(a.status).toBe(200);
          } finally {
            await j.close();
            await o.close();
          }
        },
        stallTimeout(30_000),
      );
    }

    it(
      "a persona outside the bound vault is refused identically",
      async () => {
        const j = await bootJwt();
        const o = await bootOidc({
          claimMapping: {
            persona: "p",
            allowedPersonas: ["researcher"],
            vault: "v",
            allowedVaults: ["scratch"],
          },
        });
        try {
          const a = await whoami(
            j.port,
            await hsToken({ sub: "u", persona: "researcher", vault: "scratch" }),
          );
          const b = await whoami(o.port, await idp.sign({ p: "researcher", v: "scratch" }));
          expect([a.status, b.status]).toEqual([401, 401]);
        } finally {
          await j.close();
          await o.close();
        }
      },
      stallTimeout(30_000),
    );
  });

  describe("Protected Resource Metadata", () => {
    it(
      "serves the external issuer as the authorization server and challenges with resource_metadata",
      async () => {
        const h = await bootOidc({}, { resource: RESOURCE, scopesSupported: ["read:notes"] });
        try {
          for (const path of [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
          ]) {
            const res = await fetch(`http://127.0.0.1:${h.port}${path}`);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
              resource: RESOURCE,
              authorization_servers: [ISSUER],
              scopes_supported: ["read:notes"],
              bearer_methods_supported: ["header"],
            });
          }
          const r = await whoami(h.port, "junk");
          expect(r.status).toBe(401);
          const challenge = r.headers.get("www-authenticate") ?? "";
          expect(challenge).toContain(
            'resource_metadata="https://vault.example.com/.well-known/oauth-protected-resource/mcp"',
          );
          expect(challenge).toContain('scope="read:notes"');
        } finally {
          await h.close();
        }
      },
      stallTimeout(30_000),
    );

    it(
      "without a configured resource no PRM is served (RFC 9728 requires resource)",
      async () => {
        const h = await bootOidc();
        try {
          expect(
            (await fetch(`http://127.0.0.1:${h.port}/.well-known/oauth-protected-resource`)).status,
          ).toBe(404);
        } finally {
          await h.close();
        }
      },
      stallTimeout(30_000),
    );
  });
});

describe("oidc on /metrics", () => {
  it("a non-loopback scrape needs a valid IdP token, verified by the same verifier", async () => {
    const parsed = ServerConfigSchema.parse({
      ...CONFIG_BASE,
      auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE } },
    });
    const verifier = await createOidcVerifier(parsed.auth, {
      fetch: idp.fetch,
      resolveHost: publicResolver,
    });
    const app = createMetricsApp({
      recorder: { metrics: async () => "m 1\n", contentType: "text/plain" } as never,
      bind: "0.0.0.0",
      port: 0,
      auth: parsed.auth,
      verifier,
    });
    const get = (t?: string) =>
      app.request("/metrics", { headers: t ? { authorization: `Bearer ${t}` } : {} });
    expect((await get()).status).toBe(401);
    expect((await get("junk")).status).toBe(401);
    expect((await get(await idp.sign({ aud: "https://other.example.com" }))).status).toBe(401);
    expect((await get(await idp.sign())).status).toBe(200);
  });

  it("without a verifier an oidc server refuses every non-loopback scrape", async () => {
    const parsed = ServerConfigSchema.parse({
      ...CONFIG_BASE,
      auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE } },
    });
    const app = createMetricsApp({
      recorder: { metrics: async () => "m 1\n", contentType: "text/plain" } as never,
      bind: "0.0.0.0",
      port: 0,
      auth: parsed.auth,
    });
    expect(
      (await app.request("/metrics", { headers: { authorization: `Bearer ${await idp.sign()}` } }))
        .status,
    ).toBe(401);
  });
});
