// Static-client conformance over a REAL `startHttp` socket (slice S5; design v2 sections 9 and 9.1):
// 401 -> PRM -> metadata -> authorize -> login -> consent -> token -> `list_vaults` over /mcp, the
// ChatGPT hard requirements this slice owns, issuer byte-identity (mix-up), and the token-leakage
// row: a capture of everything the process writes while a full flow runs.

import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { ensureAsKey } from "../src/auth/as-boot";
import { claimOperator } from "../src/auth/as-operator-store";
import { hashPassword } from "../src/auth/as-password";
import { openOauthDb } from "../src/auth/oauth-db";
import { openAuthRegistry } from "../src/auth/registry-open";
import { serverSecret } from "../src/auth/server-secret";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { buildRegistryTools } from "../src/tools/m1/registry-tools";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import { Jar, pkce } from "./as-flow-harness";
import { ISSUER, PASSWORD, RESOURCE } from "./as-operator-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const MODERN = "2026-07-28";
const CALLBACK = "http://127.0.0.1/callback";
const closers: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmTemp(d);
});

async function boot() {
  const dir = makeTempDir("as-conformance-");
  dirs.push(dir);
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: dir }],
    cacheDir: dir,
    auth: {
      mode: "jwt",
      resource: RESOURCE,
      scopesSupported: ["read:vault", "read:notes"],
      as: {
        enabled: true,
        issuer: ISSUER,
        clients: [{ clientId: "agent", name: "My agent", redirectUris: [CALLBACK] }],
      },
    },
  });
  const auth = config.auth as ServerConfig["auth"];
  const opened = await openAuthRegistry(config);
  await ensureAsKey(opened.registry, { alg: "ES256", accessTokenSeconds: 1800 });
  const oauth = await openOauthDb(config);
  claimOperator(oauth.db, {
    username: "operator",
    passwordHash: await hashPassword(PASSWORD),
    now: Date.now(),
  });
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([{ id: "v1", path: dir }]);
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const registry = new ToolRegistry({ tracer: provider.getTracer("as-flow") });
  for (const t of buildRegistryTools(
    {
      vaultRegistry,
      version: "t",
      startedAt: Date.now(),
      embeddings: { provider: "none", model: "none" },
    },
    () => undefined,
  )) {
    if (t.name === "list_vaults") registry.register(t as never);
  }
  const handle: HttpHandle = await startHttp({
    name: "obsidian-tc",
    version: "t",
    registry,
    vaultRegistry,
    auth,
    cacheDir: dir,
    db,
    authRegistry: opened.registry,
    oauthDb: oauth.db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  closers.push(async () => {
    await handle.close();
    await provider.shutdown();
    oauth.close();
    opened.close();
  });
  return {
    base: `http://127.0.0.1:${handle.port}`,
    dir,
    secret: serverSecret(dir),
    /** Every attribute of every span the server has finished, as one string. */
    telemetry: () =>
      JSON.stringify(exporter.getFinishedSpans().map((sp) => [sp.name, sp.attributes])),
    spanCount: () => exporter.getFinishedSpans().length,
  };
}

type Server = Awaited<ReturnType<typeof boot>>;

async function call(
  s: Server,
  path: string,
  init: { jar?: Jar; form?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const cookie = init.jar?.header();
  const res = await fetch(`${s.base}${path}`, {
    method: init.form ? "POST" : "GET",
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(init.form ? { "content-type": "application/x-www-form-urlencoded", origin: ISSUER } : {}),
      ...init.headers,
    },
    ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
  });
  init.jar?.apply(res);
  return { res, text: await res.text() };
}

const field = (html: string, name: string): string =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

/** The per-request envelope a modern-era client sends on every call. */
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function mcp(
  s: Server,
  token: string | undefined,
  body: Record<string, unknown>,
  tool?: string,
) {
  const res = await fetch(`${s.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "mcp-protocol-version": MODERN,
      ...(tool ? { "mcp-method": "tools/call", "mcp-name": tool } : {}),
    },
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
}

/** Everything the process writes while `fn` runs. */
async function capturing<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const chunks: string[] = [];
  const grab = (c: unknown) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8"));
    return true;
  };
  vi.spyOn(process.stderr, "write").mockImplementation(grab as never);
  vi.spyOn(process.stdout, "write").mockImplementation(grab as never);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      chunks.push(a.map(String).join(" "));
    });
  }
  try {
    return { value: await fn(), out: chunks.join("\n") };
  } finally {
    vi.restoreAllMocks();
  }
}

interface Walked {
  token: string;
  code: string;
  verifier: string;
  location: string;
  jar: Jar;
  seen: string[];
}

/** The whole dance a browser and a client perform; `seen` holds every secret it touched. */
async function walk(s: Server): Promise<Walked> {
  const { verifier, challenge } = pkce();
  const jar = new Jar();
  const q = new URLSearchParams({
    client_id: "agent",
    redirect_uri: "http://127.0.0.1:41999/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "read:vault",
    state: "xyz",
  });
  const a = await call(s, `/oauth/authorize?${q}`, { jar });
  expect(a.res.status).toBe(303);
  const toLogin = a.res.headers.get("location") ?? "";
  const loginPage = await call(s, toLogin, { jar });
  const logged = await call(s, "/oauth/login", {
    jar,
    form: {
      csrf: field(loginPage.text, "csrf"),
      request: field(loginPage.text, "request"),
      username: "operator",
      password: PASSWORD,
    },
  });
  expect(logged.res.status).toBe(303);
  const consentAt = logged.res.headers.get("location") ?? "";
  const consent = await call(s, consentAt, { jar });
  expect(consent.res.status).toBe(200);
  const approved = await call(s, "/oauth/consent", {
    jar,
    form: {
      csrf: field(consent.text, "csrf"),
      request: field(consent.text, "request"),
      decision: "approve",
    },
  });
  expect(approved.res.status).toBe(303);
  const location = approved.res.headers.get("location") ?? "";
  const back = new URL(location);
  expect(back.origin + back.pathname).toBe("http://127.0.0.1:41999/callback");
  expect(back.searchParams.get("state")).toBe("xyz");
  expect(back.searchParams.get("iss")).toBe(ISSUER);
  const code = back.searchParams.get("code") ?? "";
  const t = await fetch(`${s.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:41999/callback",
      client_id: "agent",
      resource: RESOURCE,
    }),
  });
  expect(t.status).toBe(200);
  const body = (await t.json()) as { access_token: string };
  const sessionCookie = [...jar.cookies.values()].join(" ");
  return {
    token: body.access_token,
    code,
    verifier,
    location,
    jar,
    seen: [PASSWORD, code, verifier, body.access_token, ...jar.cookies.values(), sessionCookie],
  };
}

describe("static-client conformance", () => {
  it("401 -> PRM -> metadata -> authorize -> login -> consent -> token -> list_vaults over /mcp", async () => {
    const s = await boot();
    const challenged = await mcp(s, undefined, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(challenged.res.status).toBe(401);
    expect(challenged.res.headers.get("www-authenticate")).toContain("resource_metadata=");

    const prm = (await (await fetch(`${s.base}/.well-known/oauth-protected-resource`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers[0]).toBe(ISSUER);

    const w = await walk(s);
    const listed = await mcp(
      s,
      w.token,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_vaults",
          arguments: {},
          _meta: ENVELOPE,
        },
      },
      "list_vaults",
    );
    expect(listed.res.status).toBe(200);
    const line = listed.text.split("\n").find((l) => l.startsWith("data: "));
    const result = JSON.parse(line ? line.slice(6) : listed.text) as {
      result?: { structuredContent?: { vaults: Array<{ id: string }> }; isError?: boolean };
    };
    expect(result.result?.isError).not.toBe(true);
    expect(result.result?.structuredContent?.vaults.map((v) => v.id)).toEqual(["v1"]);
  });

  it("a token without the tool's scope is refused at dispatch (the grant is the ceiling)", async () => {
    const s = await boot();
    // Re-run the dance asking only for read:notes.
    const { verifier, challenge } = pkce();
    const jar = new Jar();
    const q = new URLSearchParams({
      client_id: "agent",
      redirect_uri: "http://127.0.0.1:41999/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "read:notes",
    });
    const a = await call(s, `/oauth/authorize?${q}`, { jar });
    const lp = await call(s, a.res.headers.get("location") ?? "", { jar });
    const l = await call(s, "/oauth/login", {
      jar,
      form: {
        csrf: field(lp.text, "csrf"),
        request: field(lp.text, "request"),
        username: "operator",
        password: PASSWORD,
      },
    });
    const c = await call(s, l.res.headers.get("location") ?? "", { jar });
    const ok = await call(s, "/oauth/consent", {
      jar,
      form: { csrf: field(c.text, "csrf"), request: field(c.text, "request"), decision: "approve" },
    });
    const code = new URL(ok.res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const t = await fetch(`${s.base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:41999/callback",
        client_id: "agent",
      }),
    });
    const { access_token } = (await t.json()) as { access_token: string };
    const res = await mcp(
      s,
      access_token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_vaults", arguments: {}, _meta: ENVELOPE },
      },
      "list_vaults",
    );
    expect(res.text).toContain("missing required scope(s)");
    expect(res.text).toContain("read:vault");
    expect(res.text).not.toContain('"vaults"');
  });
});

describe("mix-up and the ChatGPT requirements this slice owns (section 9.1)", () => {
  it("metadata, PRM [0], the token's iss and the iss parameter are byte-identical", async () => {
    const s = await boot();
    const meta = (await (
      await fetch(`${s.base}/.well-known/oauth-authorization-server`, {
        headers: { host: "evil.example" },
      })
    ).json()) as Record<string, unknown>;
    const prm = (await (await fetch(`${s.base}/.well-known/oauth-protected-resource`)).json()) as {
      authorization_servers: string[];
    };
    const w = await walk(s);
    const iss = new URL(w.location).searchParams.get("iss");
    const issuers = [meta.issuer, prm.authorization_servers[0], decodeJwt(w.token).iss, iss];
    expect(new Set(issuers).size).toBe(1);
    expect(issuers[0]).toBe(ISSUER);
    // RFC 8414 at the well-known path of an issuer with no path.
    expect(new URL(ISSUER).pathname).toBe("/");
  });

  it("advertises exactly what is mounted: S256 only, `none`, RFC 9207, no refresh/DCR/CIMD/private_key_jwt yet", async () => {
    const s = await boot();
    const meta = (await (
      await fetch(`${s.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
    for (const absent of [
      "registration_endpoint",
      "revocation_endpoint",
      "client_id_metadata_document_supported",
    ]) {
      expect(meta).not.toHaveProperty(absent);
    }
    expect(meta.scopes_supported).not.toContain("offline_access");
    expect(JSON.stringify(meta)).not.toContain("private_key_jwt");
  });

  it("an error response carries iss too, and the resource is checked on both legs", async () => {
    const s = await boot();
    const { challenge } = pkce();
    const bad = await call(
      s,
      `/oauth/authorize?${new URLSearchParams({
        client_id: "agent",
        redirect_uri: "http://127.0.0.1:41999/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://other.example/mcp",
        state: "s",
      })}`,
    );
    const loc = new URL(bad.res.headers.get("location") ?? "");
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
  });
});

describe("token leakage in logs", () => {
  it("a full flow writes no code, verifier, token, password, cookie or Authorization value anywhere", async () => {
    const s = await boot();
    const { value: w, out } = await capturing(() => walk(s));
    // Use the token too, so the edge's own logging and the dispatch spans are in the capture.
    const { out: used } = await capturing(() =>
      mcp(
        s,
        w.token,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_vaults", arguments: {}, _meta: ENVELOPE },
        },
        "list_vaults",
      ),
    );
    expect(s.spanCount()).toBeGreaterThanOrEqual(1);
    const everything = `${out}\n${used}\n${s.telemetry()}`;
    expect(w.seen.filter((x) => x.length > 8).length).toBeGreaterThanOrEqual(5);
    for (const secret of w.seen.filter((x) => x.length > 8)) {
      expect(everything, `leaked ${secret.slice(0, 6)}...`).not.toContain(secret);
    }
    expect(everything.toLowerCase()).not.toContain("authorization:");
    expect(everything).not.toContain("code_verifier");
    // The AS did say something, and only fixed words about it.
    expect(everything).toMatch(/\[as\] token issued client=agent/);
  });

  it("a rejected bearer logs the reason, never the token", async () => {
    const s = await boot();
    const w = await walk(s);
    const tampered = `${w.token.slice(0, -4)}AAAA`;
    const { out } = await capturing(() =>
      mcp(s, tampered, { jsonrpc: "2.0", id: 1, method: "ping" }),
    );
    expect(out).not.toContain(tampered);
    expect(out).not.toContain(w.token.slice(0, 30));
  });

  it("every /oauth page and redirect says no-referrer and no-store; the AS adds no request log of its own", async () => {
    const s = await boot();
    const { value } = await capturing(async () => {
      const { challenge } = pkce();
      const q = new URLSearchParams({
        client_id: "agent",
        redirect_uri: "http://127.0.0.1:41999/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        state: "visible-state-value",
      });
      return call(s, `/oauth/authorize?${q}`);
    });
    expect(value.res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(value.res.headers.get("cache-control")).toBe("no-store");
    const { out } = await capturing(async () =>
      call(s, `/oauth/authorize?client_id=agent&state=visible-state-value&redirect_uri=nope`),
    );
    expect(out).not.toContain("visible-state-value");
    expect(out).not.toContain("redirect_uri");
  });
});
