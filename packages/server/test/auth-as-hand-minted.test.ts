// Design v2 section 7: enabling the bundled authorization server never changes what a hand-minted
// HS256 token without an `aud` is allowed to do. Driven through the real HTTP edge, because the
// regression lived in the audience the edge's verifier resolved, not in any one function.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AS_ROUTES } from "../src/auth/as-metadata";
import { effectiveAudience, jwksWithoutAudience } from "../src/auth/protected-resource";
import { openAuthRegistry } from "../src/auth/registry-open";
import { generateSigningKey } from "../src/auth/signing-keys";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const ISSUER = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";

const handles: HttpHandle[] = [];
const dirs: string[] = [];
beforeEach(() => {
  AS_ROUTES.clear();
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmTemp(d);
  AS_ROUTES.clear();
});

const noAudToken = () =>
  new SignJWT({ sub: "litellm", scope: "read:notes" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));

function configOf(as: boolean, root: string, extra: Record<string, unknown> = {}) {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: `${root}/cache`,
    auth: {
      mode: "jwt",
      jwtSecret: SECRET,
      resource: RESOURCE,
      ...(as ? { as: { enabled: true, issuer: ISSUER } } : {}),
      ...extra,
    },
  });
}

async function mcpStatus(config: ReturnType<typeof configOf>, authRegistry?: unknown) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth: config.auth,
    ...(authRegistry === undefined ? {} : { authRegistry: authRegistry as never }),
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  handles.push(handle);
  const r = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await noAudToken()}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  return r.status;
}

describe("section 7: a hand-minted HS256 token without `aud` keeps working", () => {
  it("is accepted with the AS off (the baseline)", async () => {
    const root = makeTempDir("as-hm-off-");
    dirs.push(root);
    expect(await mcpStatus(configOf(false, root))).toBe(200);
  });

  it("is accepted with the AS enabled", async () => {
    const root = makeTempDir("as-hm-on-");
    dirs.push(root);
    expect(await mcpStatus(configOf(true, root))).toBe(200);
  });

  it("is accepted with the AS enabled AND its issuing routes mounted (PRM names the issuer)", async () => {
    AS_ROUTES.set("authorize", () => {});
    AS_ROUTES.set("token", () => {});
    const root = makeTempDir("as-hm-routes-");
    dirs.push(root);
    expect(await mcpStatus(configOf(true, root))).toBe(200);
  });

  it("is still accepted after the `as` key is rotated twice", async () => {
    AS_ROUTES.set("authorize", () => {});
    AS_ROUTES.set("token", () => {});
    const root = makeTempDir("as-hm-rotate-");
    dirs.push(root);
    const config = configOf(true, root);
    const opened = await openAuthRegistry(config);
    try {
      for (let i = 0; i < 2; i++) {
        opened.registry.rotateKey({
          purpose: "as",
          alg: "ES256",
          generated: await generateSigningKey("ES256"),
          graceSeconds: 1860,
          accessTokenSeconds: 1800,
        });
      }
      expect(await mcpStatus(config, opened.registry)).toBe(200);
    } finally {
      opened.close();
    }
  });

  it("an explicit auth.audience still binds hand-minted tokens, AS on or off", async () => {
    const root = makeTempDir("as-hm-aud-");
    dirs.push(root);
    expect(await mcpStatus(configOf(true, root, { audience: "https://other.example/mcp" }))).toBe(
      401,
    );
  });
});

describe("the AS default never leaks into the mint/JWKS audience (every caller)", () => {
  // The world after the issuing slice ships: the PRM default is live, and must still bind nothing.
  beforeEach(() => {
    AS_ROUTES.set("authorize", () => {});
    AS_ROUTES.set("token", () => {});
  });
  const root = "/tmp/unused";
  const on = configOf(true, root).auth;
  const off = configOf(false, root).auth;

  it("effectiveAudience is identical with the AS on or off", () => {
    expect(effectiveAudience(on)).toBe(effectiveAudience(off));
    expect(effectiveAudience(on)).toBeUndefined();
  });

  it("jwksWithoutAudience (doctor, startup line, server_health) is identical with the AS on or off", () => {
    const jwks = { keys: [{ kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "k" }] };
    expect(jwksWithoutAudience({ ...on, jwks })).toBe(jwksWithoutAudience({ ...off, jwks }));
  });

  it("an explicit authorizationServers list still binds the resource, as it did before the AS", () => {
    const explicit = configOf(false, root, { authorizationServers: ["https://idp.example"] }).auth;
    expect(effectiveAudience(explicit)).toBe(RESOURCE);
    const withAs = configOf(true, root, { authorizationServers: [ISSUER] }).auth;
    expect(effectiveAudience(withAs)).toBe(RESOURCE);
  });
});
