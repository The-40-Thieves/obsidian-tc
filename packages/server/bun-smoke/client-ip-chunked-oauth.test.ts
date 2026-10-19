// The per-IP login limit must hold for a chunked POST to /oauth/login under Bun. hono's bodyLimit,
// mounted on /oauth/*, replaces the request for a body with no Content-Length (GHSA-9vqf-7f2p-gf9v),
// and Bun's `server.requestIP` answers only for the request it created. A peer read after that
// replacement was lost, the login path skipped the per-IP limiter, and `Transfer-Encoding: chunked`
// bypassed per-IP brute-force limiting. The unit cases are in test/client-ip-capture.test.ts; this file
// proves it on a real socket under Bun, where the defect exists. Vitest runs under Node, where the peer
// comes from the socket and the defect cannot show.
//
// Loopback peers are unattributed by design, so the test trusts 127.0.0.0/8 and sends one forwarded
// client address: the resolver then names that client when the peer is read, and nothing when it is not.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FolderAcl } from "../src/acl";
import { captureClientPeer } from "../src/auth/client-ip";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb, provisionOauthDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp } from "../src/transports/http";
import { type ServerHandle, serveHono } from "../src/transports/serve";

const ISSUER = "https://vault.example.com";
const RESOURCE = `${ISSUER}/mcp`;
const SETUP_TOKEN = "setup-token-0123456789-abcdefghijkl";
const PASSWORD = "correct horse battery staple";
const CLIENT = "198.51.100.7";
// auth.as.login.maxFailuresPerWindow default (5) × as-operator.ts IP_BUDGET_FACTOR (4).
const IP_LIMIT = 5 * 4;

const ENV_KEY = "OBSIDIAN_TC_AS_SETUP_TOKEN";

let server: ServerHandle | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env[ENV_KEY];
  process.env[ENV_KEY] = SETUP_TOKEN;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (savedToken === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedToken;
});

async function startClaimedServer(parented = false): Promise<string> {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const oauthDb = await openDatabase(":memory:");
  provisionOauthDb(oauthDb, { version: "t" });
  const handle = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth: ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: {
        mode: "jwt",
        jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
        resource: RESOURCE,
        as: { enabled: true, issuer: ISSUER },
      },
    }).auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
    oauthDb,
    trustedProxies: ["127.0.0.0/8"],
    forwardedHeader: "x-forwarded-for",
  });
  // An embedder mounts the app under its own Hono app. The parent registers the capture first, then
  // a body-rebuilding middleware, so the request is replaced after the peer was recorded.
  const parent = new Hono();
  parent.use("*", captureClientPeer);
  parent.use("/oauth/*", bodyLimit({ maxSize: 1024 * 1024 }));
  parent.route("/", handle.app);
  server = await serveHono(parented ? parent : handle.app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${server.port}`;

  // Claim the operator through the setup page, as an operator would.
  const setup = await page(base, "/oauth/setup");
  const claimed = await fetch(`${base}/oauth/setup`, {
    method: "POST",
    headers: headersFor(setup, ISSUER),
    body: new URLSearchParams({
      csrf: setup.csrf,
      token: SETUP_TOKEN,
      username: "operator",
      password: PASSWORD,
      confirm: PASSWORD,
    }),
    redirect: "manual",
  });
  expect(claimed.status).toBe(303);
  return base;
}

/** A GET of a form page: its cookies and its CSRF token. */
async function page(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? "";
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { cookie, csrf };
}

function headersFor(p: { cookie: string }, origin: string): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    origin,
    cookie: p.cookie,
  };
}

/** One wrong-password login from the forwarded client. A chunked body has no Content-Length, which is
 *  the request shape that bodyLimit replaces. */
async function failedLogin(
  base: string,
  login: { cookie: string; csrf: string },
  username: string,
  chunked: boolean,
): Promise<number> {
  const body = new URLSearchParams({
    csrf: login.csrf,
    username,
    password: "not the password",
  }).toString();
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: { ...headersFor(login, ISSUER), "x-forwarded-for": CLIENT },
    redirect: "manual",
  };
  init.body = chunked
    ? new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      })
    : body;
  if (chunked) init.duplex = "half";
  const res = await fetch(`${base}/oauth/login`, init);
  await res.text();
  return res.status;
}

/** Failed logins, each for a different account (so the per-account limit never trips), until the
 *  per-IP limit refuses one. Returns the status of every attempt. */
async function attemptsUntilRefused(chunked: boolean, parented = false): Promise<number[]> {
  const base = await startClaimedServer(parented);
  const login = await page(base, "/oauth/login");
  const statuses: number[] = [];
  for (let i = 0; i <= IP_LIMIT; i++) {
    statuses.push(await failedLogin(base, login, `nobody-${i}`, chunked));
  }
  return statuses;
}

test("a Content-Length POST to /oauth/login counts against the per-IP limit (control)", async () => {
  const statuses = await attemptsUntilRefused(false);
  expect(statuses.slice(0, IP_LIMIT).every((s) => s !== 429)).toBe(true);
  expect(statuses[IP_LIMIT]).toBe(429);
}, 60_000);

test("a chunked POST to /oauth/login counts against the per-IP limit, the same way", async () => {
  const statuses = await attemptsUntilRefused(true);
  expect(statuses.slice(0, IP_LIMIT).every((s) => s !== 429)).toBe(true);
  expect(statuses[IP_LIMIT]).toBe(429);
}, 60_000);

test("a chunked POST counts against the per-IP limit when a parent app mounts the capture first and rebuilds the body", async () => {
  const statuses = await attemptsUntilRefused(true, true);
  expect(statuses.slice(0, IP_LIMIT).every((s) => s !== 429)).toBe(true);
  expect(statuses[IP_LIMIT]).toBe(429);
}, 60_000);
