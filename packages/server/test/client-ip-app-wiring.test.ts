// createHttpApp must record the TCP peer before its own body-rebuilding middleware (hono's bodyLimit on
// /oauth/*) replaces a chunked request. Under Bun the wiring is proven by bun-smoke/client-ip-chunked-oauth
// test; this file proves it under Node, where the peer comes from a fake `requestIP` that answers only
// for the original Request object, the same way Bun's does. Deleting `app.use("*", captureClientPeer)`
// in createHttpApp makes the chunked login lose its address, and the operator log line loses it too.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { claimOperator } from "../src/auth/as-operator-store";
import { hashPassword } from "../src/auth/as-password";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { provisionAuthDb, provisionOauthDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { PASSWORD, RESOURCE } from "./as-operator-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const ISSUER = "https://vault.example.com";
const PEER = "203.0.113.9";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  vi.restoreAllMocks();
});

async function claimedApp(): Promise<{ app: Hono; close: () => Promise<void> }> {
  const dir = makeTempDir("client-ip-wiring-");
  closers.push(() => rmTemp(dir));
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: dir }],
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: RESOURCE,
      as: { enabled: true, issuer: ISSUER },
    },
  }).auth as never;
  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const oauthDb = openMemoryDb();
  provisionOauthDb(oauthDb, { version: "t" });
  claimOperator(oauthDb, {
    username: "operator",
    passwordHash: await hashPassword(PASSWORD),
    now: Date.now(),
  });
  const handle: HttpApp = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth,
    db: openMemoryDb(),
    oauthDb,
    authRegistry: createAuthRegistry(authDb, { keysDir: authKeysDir(dir) }),
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
  } as never);
  closers.push(() => handle.close());
  return { app: handle.app, close: () => handle.close() };
}

/** A chunked (no Content-Length) wrong-password login. The env answers the peer for this request only. */
async function chunkedFailedLogin(app: Hono, cookie: string, csrf: string): Promise<number> {
  const body = new URLSearchParams({ csrf, username: "nobody", password: "not the password" });
  const req = new Request(`${ISSUER}/oauth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body.toString()));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  const res = await app.fetch(req, {
    requestIP: (r: Request) => (r === req ? { address: PEER } : null),
  });
  await res.text();
  return res.status;
}

describe("createHttpApp records the client peer before its body-rebuilding middleware", () => {
  it("a chunked failed login is logged with the peer's address", async () => {
    const { app } = await claimedApp();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const page = await app.fetch(new Request(`${ISSUER}/oauth/login`), {});
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const cookie = page.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(await chunkedFailedLogin(app, cookie, csrf)).toBe(401);
    const lines = write.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(`[as] operator login failed (${PEER})\n`);
  });
});
