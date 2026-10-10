// The operator routes (slice S4) as `createHttpApp` mounts them: only for an enabled AS that was
// given its oauth.db, behind the same app as /mcp, and without turning discovery on (no authorize or
// token route exists yet, so nothing may be advertised).
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AS_ROUTES } from "../src/auth/as-metadata";
import { provisionCacheDb, provisionOauthDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, startHttp } from "../src/transports/http";
import {
  get,
  ISSUER,
  Jar,
  login,
  type OperatorFixture,
  PASSWORD,
  post,
  RESOURCE,
  SETUP_TOKEN,
  submit,
} from "./as-operator-harness";
import { openMemoryDb } from "./helpers";

const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
  // Importing the HTTP transport registers the issuing routes; these tests are about the world before.
  AS_ROUTES.clear();
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  AS_ROUTES.clear();
});

function authOf(asOver: Record<string, unknown> | false = {}): ServerConfig["auth"] {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: RESOURCE,
      ...(asOver === false ? {} : { as: { enabled: true, issuer: ISSUER, ...asOver } }),
    },
  }).auth as ServerConfig["auth"];
}

function build(opts: { as?: Record<string, unknown> | false; withOauthDb?: boolean } = {}) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const oauthDb = openMemoryDb();
  provisionOauthDb(oauthDb, { version: "t" });
  const handle = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth: authOf(opts.as),
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    // The Host guard is not under test here; the bearer check behind it is.
    enableDnsRebindingProtection: false,
    ...(opts.withOauthDb === false ? {} : { oauthDb }),
  });
  closers.push(() => handle.close());
  const fixture = {
    app: handle.app,
    issuer: ISSUER,
    url: (path: string) => `${ISSUER}${path}`,
  } as unknown as OperatorFixture;
  return { handle, oauthDb, fixture };
}

describe("mounting", () => {
  it("serves the login page for an enabled AS with its oauth.db: unclaimed, refusing, frame-proof", async () => {
    const { fixture } = build();
    const res = await fixture.app.request(fixture.url("/oauth/login"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toMatch(/not claimed/i);
  });

  it("does not turn discovery on: no metadata and no authorize route exist in this slice", async () => {
    const { fixture } = build();
    const meta = await fixture.app.request(fixture.url("/.well-known/oauth-authorization-server"));
    expect(meta.status).toBe(404);
    const alias = await fixture.app.request(fixture.url("/.well-known/openid-configuration"));
    expect(alias.status).toBe(404);
  });

  it("is not mounted when the AS is off, or when no oauth.db was supplied", async () => {
    for (const b of [build({ as: false }), build({ withOauthDb: false })]) {
      for (const path of ["/oauth/login", "/oauth/setup", "/oauth/as.css"]) {
        const res = await b.fixture.app.request(b.fixture.url(path));
        expect(res.status, path).toBe(404);
      }
    }
  });

  it("leaves /mcp behind its bearer check", async () => {
    const { fixture } = build();
    const res = await fixture.app.request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer junk",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("claims, logs in and logs out end to end through the mounted app", async () => {
    const { fixture, oauthDb } = build();
    process.env.OBSIDIAN_TC_AS_SETUP_TOKEN = SETUP_TOKEN;
    try {
      const claim = await submit(fixture, "/oauth/setup", {
        token: SETUP_TOKEN,
        username: "operator",
        password: PASSWORD,
        confirm: PASSWORD,
      });
      expect(claim.res.status).toBe(303);
      const jar = new Jar();
      expect((await login(fixture, jar)).res.status).toBe(303);
      const page = await get(fixture, "/oauth/login", jar);
      expect(page.text).toMatch(/\/oauth\/logout/);
      expect((await post(fixture, "/oauth/logout", { csrf: page.csrf }, jar)).res.status).toBe(303);
      expect(oauthDb.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    } finally {
      delete process.env.OBSIDIAN_TC_AS_SETUP_TOKEN;
    }
  });

  it("answers over a real socket, from a loopback peer, without crashing on the address", async () => {
    const oauthDb = openMemoryDb();
    provisionOauthDb(oauthDb, { version: "t" });
    const db = openMemoryDb();
    provisionCacheDb(db);
    const handle = await startHttp({
      name: "obsidian-tc",
      version: "t",
      registry: new ToolRegistry(),
      auth: authOf(),
      db,
      oauthDb,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
    });
    closers.push(() => handle.close());
    const res = await fetch(`http://127.0.0.1:${handle.port}/oauth/login`);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("socketClientIp", () => {
  const ctx = (env: unknown, headers: Record<string, string> = {}) =>
    ({
      env,
      req: { raw: new Request("https://x.test/", { headers }), header: (n: string) => headers[n] },
    }) as unknown as Context;

  it("reads the Node socket address and ignores X-Forwarded-For", async () => {
    const { socketClientIp } = await import("../src/auth/client-ip");
    const c = ctx(
      { incoming: { socket: { remoteAddress: "203.0.113.5" } } },
      {
        "x-forwarded-for": "198.51.100.1",
      },
    );
    expect(socketClientIp(c)).toBe("203.0.113.5");
  });

  it("reads the Bun server's requestIP", async () => {
    const { socketClientIp } = await import("../src/auth/client-ip");
    const c = ctx({ requestIP: () => ({ address: "203.0.113.6", family: "IPv4", port: 1 }) });
    expect(socketClientIp(c)).toBe("203.0.113.6");
  });

  it("returns nothing for a loopback peer (a same-host proxy), an unknown peer or an absent env", async () => {
    const { socketClientIp } = await import("../src/auth/client-ip");
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(
        socketClientIp(ctx({ incoming: { socket: { remoteAddress: address } } })),
      ).toBeUndefined();
    }
    expect(socketClientIp(ctx({}))).toBeUndefined();
    expect(socketClientIp(ctx(undefined))).toBeUndefined();
  });
});
