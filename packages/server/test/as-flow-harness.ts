// Shared fixture for the authorize / consent / token suites (slice S5): the real HTTP app with the
// bundled authorization server's routes mounted over an in-memory oauth.db and a real auth registry
// holding an `as` key, a controllable clock for the AS (it starts at the real time so the tokens it
// signs still verify at /mcp), a log sink, and helpers that walk a flow the way a client and a
// browser would.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { mountAsRoutes } from "../src/auth/as-metadata";
import { mountAsOperator } from "../src/auth/as-operator";
import { claimOperator } from "../src/auth/as-operator-store";
import { hashPassword } from "../src/auth/as-password";
import "../src/auth/as-issuing";
import { type AuthRegistry, authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey } from "../src/auth/signing-keys";
import { provisionAuthDb, provisionCacheDb, provisionOauthDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { buildRegistryTools } from "../src/tools/m1/registry-tools";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import {
  get,
  ISSUER,
  Jar,
  type OperatorFixture,
  PASSWORD,
  post,
  RESOURCE,
  SECRET,
  type Seen,
} from "./as-operator-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

export { get, ISSUER, Jar, PASSWORD, post, RESOURCE, type Seen };

export const CLIENT_ID = "test-client";
export const CLIENT_REDIRECT = "https://app.example/cb";
export const LOOPBACK_CLIENT = "native-client";
export const SECRET_CLIENT = "secret-client";
export const SECRET_CLIENT_ENV = "OTC_TEST_AS_CLIENT_SECRET";
export const SECRET_CLIENT_SECRET = "s3cret-client-value-0123456789";
export const MIN = 60_000;

const CLIENTS = [
  { clientId: CLIENT_ID, name: "Test Client", redirectUris: [CLIENT_REDIRECT] },
  {
    clientId: LOOPBACK_CLIENT,
    name: "Native Client",
    redirectUris: ["http://localhost/cb", "http://127.0.0.1/callback"],
  },
  {
    clientId: SECRET_CLIENT,
    name: "Secret Client",
    redirectUris: ["https://secret.example/cb"],
    secretEnv: SECRET_CLIENT_ENV,
  },
];

const dirs: string[] = [];
export const cleanupFlows = (): void => {
  for (const d of dirs.splice(0)) rmTemp(d);
};

export interface Flow extends OperatorFixture {
  handle: HttpApp;
  registry: AuthRegistry;
  clock: { t: number };
  logs: string[];
  auth: ServerConfig["auth"];
  /** The same oauth.db the routes use. */
  db: ReturnType<typeof openMemoryDb>;
  /** The same stores behind a freshly started app whose server secret is `secret` (a replaced secret). */
  restartWith(secret: string): Flow;
}

export async function makeFlow(
  opts: {
    as?: Record<string, unknown>;
    personas?: Record<string, unknown>;
    claim?: boolean;
    scopesSupported?: string[];
    /** Vault ids the server holds (default `["v1"]`); the first is also the HTTP default unless `defaultVault`. */
    vaults?: string[];
    defaultVault?: string;
  } = {},
): Promise<Flow> {
  process.env[SECRET_CLIENT_ENV] = SECRET_CLIENT_SECRET;
  const dir = makeTempDir("as-flow-");
  dirs.push(dir);
  const vaultDefs = (opts.vaults ?? ["v1"]).map((id, i) => {
    const path = i === 0 ? dir : join(dir, id);
    mkdirSync(path, { recursive: true });
    return { id, path };
  });
  const config = ServerConfigSchema.parse({
    vaults: vaultDefs,
    cacheDir: dir,
    auth: {
      mode: "jwt",
      resource: RESOURCE,
      ...(opts.scopesSupported ? { scopesSupported: opts.scopesSupported } : {}),
      as: { enabled: true, issuer: ISSUER, clients: CLIENTS, ...opts.as },
    },
    ...(opts.personas ? { personas: opts.personas } : {}),
  });
  const auth = config.auth as ServerConfig["auth"];

  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const registry = createAuthRegistry(authDb, { keysDir: authKeysDir(dir) });
  registry.rotateKey({
    purpose: "as",
    alg: "ES256",
    generated: await generateSigningKey("ES256"),
    graceSeconds: 0,
  });

  const db = openMemoryDb();
  provisionOauthDb(db, { version: "t" });
  if (opts.claim !== false) {
    claimOperator(db, {
      username: "operator",
      passwordHash: await hashPassword(PASSWORD),
      now: Date.now(),
    });
  }

  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const vaultRegistry = new VaultRegistry(vaultDefs);
  const tools = new ToolRegistry();
  for (const t of buildRegistryTools(
    {
      vaultRegistry,
      version: "t",
      startedAt: Date.now(),
      embeddings: { provider: "none", model: "none" },
    },
    () => undefined,
  )) {
    if (t.name === "list_vaults") tools.register(t as never);
  }
  tools.register({
    name: "noop",
    description: "test-only",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: () => ({}),
  } as never);

  const clock = { t: Date.now() };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  // The HTTP app over THIS oauth.db and registry, for the server secret `secret`: a restart with a
  // replaced secret is a second app over the same stores.
  const appFor = (secret: string): HttpApp => {
    const handle = createHttpApp({
      name: "obsidian-tc",
      version: "t",
      registry: tools,
      vaultRegistry,
      auth,
      db: cacheDb,
      authRegistry: registry,
      vaultId: opts.defaultVault ?? vaultDefs[0]?.id ?? "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      enableDnsRebindingProtection: false,
      personas: config.personas,
    });
    mountAsOperator(handle.app, {
      auth,
      db,
      secret,
      now: () => clock.t,
      log,
      env: {},
      clientIp: (c) => c.req.header("x-test-ip"),
    });
    mountAsRoutes(handle.app, auth, {
      db,
      registry,
      secret,
      personas: config.personas,
      now: () => clock.t,
      log,
      clientIp: (c) => c.req.header("x-test-ip"),
    });
    return handle;
  };
  const handle = appFor(SECRET);

  const flow: Flow = {
    handle,
    app: handle.app,
    db,
    clock,
    logs,
    env: {},
    calls: { hash: 0, verify: 0 },
    issuer: ISSUER,
    url: (path: string) => `${ISSUER}${path}`,
    registry,
    auth,
    restartWith: (secret: string) => {
      const next = appFor(secret);
      return { ...flow, handle: next, app: next.app };
    },
  };
  return flow;
}

export const sha256Url = (s: string): string => createHash("sha256").update(s).digest("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: sha256Url(verifier) };
}

/** A well-formed request; `undefined` in `over` removes a parameter. */
export function authorizeQuery(
  challenge: string,
  over: Record<string, string | undefined> = {},
): string {
  const base: Record<string, string | undefined> = {
    client_id: CLIENT_ID,
    redirect_uri: CLIENT_REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "read:notes",
    state: "st-123",
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== undefined) q.set(k, v);
  return q.toString();
}

export async function authorize(
  flow: Flow,
  jar: Jar,
  challenge: string,
  over: Record<string, string | undefined> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const cookie = jar.header();
  const res = await flow.app.request(
    flow.url(`/oauth/authorize?${authorizeQuery(challenge, over)}`),
    {
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      redirect: "manual",
    },
  );
  jar.apply(res);
  return res;
}

/** The pending-request handle in a `/oauth/login` or `/oauth/consent` Location. */
export const handleOf = (location: string | null): string =>
  new URL(location ?? "", ISSUER).searchParams.get("request") ?? "";

/** Sign in through the login form that carries `request`, and return the response to that POST. */
export async function loginFor(flow: Flow, jar: Jar, location: string): Promise<Seen> {
  const page = await get(flow, location, jar);
  const request = /name="request" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
  return post(
    flow,
    "/oauth/login",
    { csrf: page.csrf, request, username: "operator", password: PASSWORD },
    jar,
  );
}

export interface ConsentPage {
  csrf: string;
  request: string;
  seen: Seen;
}

export async function consentPage(flow: Flow, jar: Jar, handle: string): Promise<ConsentPage> {
  const seen = await get(flow, `/oauth/consent?request=${handle}`, jar);
  const request = /name="request" value="([^"]+)"/.exec(seen.text)?.[1] ?? "";
  return { csrf: seen.csrf, request, seen };
}

export const consentPost = (
  flow: Flow,
  jar: Jar,
  fields: Record<string, string>,
  extra: Parameters<typeof post>[4] = {},
): Promise<Seen> => post(flow, "/oauth/consent", fields, jar, extra);

export function codeOf(location: string | null): string {
  return new URL(location || "https://x.invalid/").searchParams.get("code") ?? "";
}

/** authorize -> login -> consent -> approve, returning the code the client would receive. */
export async function obtainCode(
  flow: Flow,
  jar: Jar,
  challenge: string,
  over: Record<string, string | undefined> = {},
  consent: Record<string, string> = {},
): Promise<{ code: string; location: string }> {
  const a = await authorize(flow, jar, challenge, over);
  const next = a.headers.get("location") ?? "";
  const handle = handleOf(next);
  let at = next;
  if (next.startsWith("/oauth/login")) {
    const l = await loginFor(flow, jar, next);
    at = l.res.headers.get("location") ?? "";
  }
  if (!at.startsWith("/oauth/consent")) {
    return { code: codeOf(at), location: at };
  }
  const page = await consentPage(flow, jar, handle);
  if (page.seen.res.status === 303) {
    const loc = page.seen.res.headers.get("location") ?? "";
    return { code: codeOf(loc), location: loc };
  }
  const done = await consentPost(flow, jar, {
    csrf: page.csrf,
    request: page.request,
    decision: "approve",
    ...consent,
  });
  const location = done.res.headers.get("location") ?? "";
  return { code: codeOf(location), location };
}

export async function exchange(
  flow: Flow,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  const res = await flow.app.request(flow.url("/oauth/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: body.toString(),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

export const tokenFields = (
  code: string,
  verifier: string,
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  grant_type: "authorization_code",
  code,
  code_verifier: verifier,
  redirect_uri: CLIENT_REDIRECT,
  client_id: CLIENT_ID,
  resource: RESOURCE,
  ...over,
});

export const refreshFields = (
  refreshToken: string | undefined,
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
  client_id: CLIENT_ID,
  ...over,
});

export interface Issued {
  access: string;
  refresh: string;
  body: Record<string, unknown>;
}

/** The whole authorization-code flow for the default client: its first access and refresh token. */
export async function issue(
  flow: Flow,
  over: Record<string, string | undefined> = {},
  consent: Record<string, string> = {},
): Promise<Issued> {
  const { verifier, challenge } = pkce();
  const { code } = await obtainCode(flow, new Jar(), challenge, over, consent);
  // A client other than the default names itself (and its redirect) in the authorize query: so does the exchange.
  const bound: Record<string, string> = {};
  if (over.client_id !== undefined) bound.client_id = over.client_id;
  if (over.redirect_uri !== undefined) bound.redirect_uri = over.redirect_uri;
  const { res, body } = await exchange(flow, tokenFields(code, verifier, bound));
  if (res.status !== 200) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return { access: body.access_token as string, refresh: body.refresh_token as string, body };
}

export const basicAuth = (id: string, secret: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
});

/** `POST /oauth/revoke`: RFC 7009 answers with an empty body, so the text is returned as is. */
export async function revokeCall(
  flow: Flow,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
): Promise<{ res: Response; text: string }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  const res = await flow.app.request(flow.url("/oauth/revoke"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: body.toString(),
  });
  return { res, text: await res.text() };
}

/** A bearer call to the MCP edge; 200 means the token verified. */
export async function mcpPing(flow: Flow, token: string): Promise<number> {
  const res = await flow.app.request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  return res.status;
}

/** The vault ids `list_vaults` shows a bearer token over /mcp (a vault-bound token sees only its own). */
export async function mcpVaults(flow: Flow, token: string): Promise<string[]> {
  const res = await flow.app.request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "list_vaults",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "list_vaults",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "harness", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : text) as {
    result?: { structuredContent?: { vaults: Array<{ id: string }> } };
  };
  return msg.result?.structuredContent?.vaults.map((v) => v.id) ?? [];
}

export const rows = <T>(flow: Flow, sql: string, ...p: unknown[]): T[] =>
  flow.db.prepare(sql).all(...p) as T[];
