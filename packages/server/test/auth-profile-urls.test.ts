// OAuth on tool-budget profile URLs (`/mcp/<surface>`). A client that types any of
// R, R/essentials, R/core, R/full, R/triad, R/domain, with R = auth.resource, must be able to sign in
// and call tools. The 401 on R/<surface> has to point at a Protected Resource Metadata document that
// is SERVED and whose `resource` is the URL the client typed (clients compare the two); the bundled
// authorization server then issues `aud` = that URL, and the resource server accepts the derived set
// on every surface (profiles are advertisement-only, never an authorization boundary).
//
// The sign-in below is the MCP SDK client's own (401 -> resource_metadata -> PRM -> AS metadata ->
// PKCE -> token), so it exercises what real clients do rather than a hand-walked flow.
import { randomUUID } from "node:crypto";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { decodeJwt, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { allowedResources, matchResource } from "../src/auth/resource-set";
import { importSigningKey, isAsymmetricAlg } from "../src/auth/signing-keys";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { URL_SURFACE_NAMES } from "../src/mcp/tool-profiles";
import { createHttpApp } from "../src/transports/http";
import {
  authorize,
  CLIENT_ID,
  CLIENT_REDIRECT,
  cleanupFlows,
  exchange,
  type Flow,
  issue,
  makeFlow,
  obtainCode,
  pkce,
  refreshFields,
  tokenFields,
} from "./as-flow-harness";
import { ISSUER, Jar, RESOURCE } from "./as-operator-harness";
import { openMemoryDb } from "./helpers";

const SURFACES = ["essentials", "core", "full", "triad", "domain"] as const;
const MODERN = "2026-07-28";
afterEach(cleanupFlows);

const urlOf = (surface?: string) => (surface === undefined ? RESOURCE : `${RESOURCE}/${surface}`);

/** The in-process app answers every URL the client builds; the host in the URL is the issuer's. */
const fetchFor =
  (flow: Flow): typeof fetch =>
  (input, init) =>
    Promise.resolve(flow.app.request(input as string | URL | Request, init));

async function post(
  flow: Flow,
  path: string,
  token: string | undefined,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "ping" },
): Promise<Response> {
  return flow.app.request(`${ISSUER}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

/** tools/call list_vaults at `path`: flat surfaces dispatch it directly. */
async function listVaults(flow: Flow, path: string, token: string): Promise<number> {
  const res = await flow.app.request(`${ISSUER}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
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
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  await res.text();
  return res.status;
}

const resourceMetadataOf = (res: Response): string | undefined =>
  /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1];

/** An in-memory OAuth provider for the pre-registered test client; records the URL it is sent to. */
function providerFor() {
  let tokens: Awaited<ReturnType<NonNullable<OAuthClientProvider["tokens"]>>>;
  let verifier = "";
  const sent: URL[] = [];
  const provider: OAuthClientProvider = {
    redirectUrl: CLIENT_REDIRECT,
    clientMetadata: {
      client_name: "Test Client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      scope: "read:notes",
    },
    state: () => "st-123",
    clientInformation: () => ({ client_id: CLIENT_ID }),
    tokens: () => tokens,
    saveTokens: (t) => {
      tokens = t;
    },
    redirectToAuthorization: (u) => {
      sent.push(u);
    },
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
  };
  return { provider, sent, tokens: () => tokens };
}

/** Sign in at `url` the way an MCP client does, and return the access token it ends up holding. */
async function signInAt(flow: Flow, url: string) {
  const { provider, sent, tokens } = providerFor();
  const fetchFn = fetchFor(flow);
  const first = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: provider,
    fetch: fetchFn,
  });
  await expect(new Client({ name: "t", version: "1" }).connect(first)).rejects.toBeInstanceOf(
    UnauthorizedError,
  );
  const authUrl = sent[0];
  if (authUrl === undefined) throw new Error("the client was never sent to the authorization URL");
  const over: Record<string, string> = {};
  for (const [k, v] of authUrl.searchParams) over[k] = v;
  const { code } = await obtainCode(
    flow,
    new Jar(),
    authUrl.searchParams.get("code_challenge") ?? "",
    over,
  );
  await first.finishAuth(code);
  return {
    provider,
    authUrl,
    access: tokens()?.access_token ?? "",
    refresh: tokens()?.refresh_token,
  };
}

describe("the derived resource set (one definition)", () => {
  it("is R plus R/<known surface>, and nothing else", () => {
    expect(allowedResources(RESOURCE)).toEqual([RESOURCE, ...URL_SURFACE_NAMES.map(urlOf)]);
    expect(URL_SURFACE_NAMES).toEqual(expect.arrayContaining([...SURFACES]));
  });

  it("matches exactly, never by prefix, and returns the member", () => {
    expect(matchResource(urlOf("essentials"), RESOURCE)).toBe(urlOf("essentials"));
    expect(matchResource(RESOURCE, RESOURCE)).toBe(RESOURCE);
    for (const bad of [
      urlOf("nope"),
      `${urlOf("essentials")}X`,
      `${RESOURCE}/../x`,
      `${RESOURCE}%2Fessentials`,
      `${urlOf("essentials")}/`,
      `${RESOURCE}/`,
      "https://evil.example/mcp/essentials",
      `${urlOf("essentials")}?x=1`,
      "",
    ]) {
      expect(matchResource(bad, RESOURCE), bad).toBeUndefined();
    }
  });

  it("derives no surfaces when R has no path to hang them on", () => {
    expect(allowedResources("https://vault.example.com")).toEqual(["https://vault.example.com"]);
  });
});

describe("401 challenge and Protected Resource Metadata per profile URL (bundled AS)", () => {
  it.each([undefined, ...SURFACES])(
    "%s: the challenged PRM URL is served and names the typed URL",
    async (surface) => {
      const flow = await makeFlow();
      const path = surface === undefined ? "/mcp" : `/mcp/${surface}`;
      const res = await post(flow, path, undefined);
      expect(res.status).toBe(401);
      const prmUrl = resourceMetadataOf(res);
      expect(prmUrl).toBe(
        `${ISSUER}/.well-known/oauth-protected-resource/mcp${surface === undefined ? "" : `/${surface}`}`,
      );
      const prm = await flow.app.request(prmUrl as string);
      expect(prm.status).toBe(200);
      const doc = (await prm.json()) as { resource: string; authorization_servers: string[] };
      expect(doc.resource).toBe(urlOf(surface));
      expect(doc.authorization_servers).toEqual([ISSUER]);
    },
  );

  it("an unknown surface has no PRM document and no challenge", async () => {
    const flow = await makeFlow();
    for (const bad of ["nope", "essentialsX", "constructor", "__proto__"]) {
      const prm = await flow.app.request(
        `${ISSUER}/.well-known/oauth-protected-resource/mcp/${bad}`,
      );
      expect(prm.status, bad).toBe(404);
      const res = await post(flow, `/mcp/${bad}`, undefined);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get("www-authenticate"), bad).toBeNull();
    }
  });

  it("the root and /mcp PRM documents keep today's shape (resource = R)", async () => {
    const flow = await makeFlow();
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const doc = (await (await flow.app.request(`${ISSUER}${p}`)).json()) as { resource: string };
      expect(doc.resource).toBe(RESOURCE);
    }
  });
});

describe("sign-in with the MCP SDK client at every profile URL", () => {
  it.each([undefined, ...SURFACES])("%s: discovery, PKCE, token, then tools", async (surface) => {
    const flow = await makeFlow();
    const url = urlOf(surface);
    const { authUrl, access } = await signInAt(flow, url);
    expect(authUrl.searchParams.get("resource")).toBe(url);
    expect(decodeJwt(access).aud).toBe(url);
    const path = surface === undefined ? "/mcp" : `/mcp/${surface}`;
    expect(await post(flow, path, access).then((r) => r.status)).toBe(200);
    if (surface !== undefined && surface !== "triad" && surface !== "domain") {
      expect(await listVaults(flow, path, access)).toBe(200);
    }
  });

  it("the SDK client lists tools on /mcp/essentials with the token it obtained", async () => {
    const flow = await makeFlow();
    const url = urlOf("essentials");
    const { provider } = await signInAt(flow, url);
    const t = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: provider,
      fetch: fetchFor(flow),
    });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(t);
    const listed = await client.listTools();
    expect(Array.isArray(listed.tools)).toBe(true);
    await client.close();
  });
});

describe("the resource server accepts the derived set on every surface", () => {
  it("a token for R works on every surface, and a token for R/essentials on /mcp and the others", async () => {
    const flow = await makeFlow();
    const forRoot = await issue(flow);
    const forEssentials = await issue(flow, { resource: urlOf("essentials") }, {});
    expect(decodeJwt(forRoot.access).aud).toBe(RESOURCE);
    expect(decodeJwt(forEssentials.access).aud).toBe(urlOf("essentials"));
    for (const token of [forRoot.access, forEssentials.access]) {
      for (const path of ["/mcp", ...SURFACES.map((s) => `/mcp/${s}`)]) {
        expect(await post(flow, path, token).then((r) => r.status), path).toBe(200);
      }
    }
  });

  it("a token whose aud is outside the set is refused, even when an as key signed it", async () => {
    const flow = await makeFlow();
    const { kid, alg, secret } = flow.registry.signingKey({ purpose: "as" });
    if (!isAsymmetricAlg(alg)) throw new Error("the as key is asymmetric");
    const key = await importSigningKey(alg, secret);
    const signed = (aud: string) =>
      new SignJWT({ client_id: CLIENT_ID, scope: "read:notes" })
        .setProtectedHeader({ alg, typ: "at+jwt", kid })
        .setIssuer(ISSUER)
        .setSubject("operator")
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("10m")
        .setJti(randomUUID())
        .sign(key);
    // The control: the same forgery shape with an audience in the set verifies.
    expect(
      await post(flow, "/mcp/essentials", await signed(urlOf("essentials"))).then((r) => r.status),
    ).toBe(200);
    for (const aud of [urlOf("nope"), `${urlOf("essentials")}X`, "https://evil.example/mcp"]) {
      expect(
        await post(flow, "/mcp/essentials", await signed(aud)).then((r) => r.status),
        aud,
      ).toBe(401);
    }
  });
});

describe("the authorization server's resource indicator", () => {
  it("refuses an unknown surface and lookalike names at the authorize endpoint", async () => {
    const flow = await makeFlow();
    const { challenge } = pkce();
    for (const resource of [
      urlOf("nope"),
      `${urlOf("essentials")}X`,
      `${RESOURCE}/../x`,
      `${RESOURCE}%2Fessentials`,
      `${RESOURCE}/essentials/`,
    ]) {
      const res = await authorize(flow, new Jar(), challenge, { resource });
      const loc = res.headers.get("location") ?? "";
      expect(new URL(loc, ISSUER).searchParams.get("error"), resource).toBe("invalid_target");
    }
  });

  it("refuses at the token endpoint a resource other than the one the code was issued for", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {
      resource: urlOf("essentials"),
    });
    for (const resource of [urlOf("nope"), `${urlOf("essentials")}X`, RESOURCE, urlOf("core")]) {
      const { res, body } = await exchange(flow, tokenFields(code, verifier, { resource }));
      expect(res.status, resource).toBe(400);
      expect(body.error, resource).toBe("invalid_target");
    }
    // The refusals above did not spend the code.
    const ok = await exchange(flow, tokenFields(code, verifier, { resource: urlOf("essentials") }));
    expect(ok.res.status).toBe(200);
  });

  it("with no resource at the token endpoint the code's own resource is the audience", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, { resource: urlOf("core") });
    const ok = await exchange(flow, tokenFields(code, verifier, { resource: undefined }));
    expect(ok.res.status).toBe(200);
    expect(decodeJwt(ok.body.access_token as string).aud).toBe(urlOf("core"));
  });

  it("refresh keeps the resource, and refuses a different one", async () => {
    const flow = await makeFlow();
    const first = await issue(flow, { resource: urlOf("essentials") });
    const bad = await exchange(flow, refreshFields(first.refresh, { resource: urlOf("core") }));
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toBe("invalid_target");
    const worse = await exchange(flow, refreshFields(first.refresh, { resource: urlOf("nope") }));
    expect(worse.body.error).toBe("invalid_target");
    const next = await exchange(flow, refreshFields(first.refresh));
    expect(next.res.status).toBe(200);
    expect(decodeJwt(next.body.access_token as string).aud).toBe(urlOf("essentials"));
    const named = await exchange(
      flow,
      refreshFields(next.body.refresh_token as string, { resource: urlOf("essentials") }),
    );
    expect(named.res.status).toBe(200);
    expect(decodeJwt(named.body.access_token as string).aud).toBe(urlOf("essentials"));
  });
});

describe("GET and DELETE on a profile URL", () => {
  it("an unknown surface is 404, a known one stays 405", async () => {
    const flow = await makeFlow();
    for (const method of ["GET", "DELETE"]) {
      const at = (p: string) => flow.app.request(`${ISSUER}${p}`, { method });
      expect((await at("/mcp/nope")).status, `${method} nope`).toBe(404);
      expect((await at("/mcp/constructor")).status, `${method} constructor`).toBe(404);
      expect((await at("/mcp/essentials")).status, `${method} essentials`).toBe(405);
      expect((await at("/mcp")).status, `${method} /mcp`).toBe(405);
    }
  });
});

describe("external authorization server (auth.mode: jwt, no bundled AS)", () => {
  const SECRET = "external-as-test-secret-0123456789-abcdefghij";
  const EXTERNAL = "https://idp.example.com";

  function appFor(auth: Record<string, unknown>) {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const cfg = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: { mode: "jwt", jwtSecret: SECRET, resource: RESOURCE, ...auth },
    }).auth;
    return createHttpApp({
      name: "obsidian-tc",
      version: "t",
      registry: new ToolRegistry(),
      auth: cfg,
      db,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      enableDnsRebindingProtection: false,
    });
  }

  const sign = (aud: string) =>
    new SignJWT({ scope: "read:notes" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("someone")
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(SECRET));

  const ping = async (a: ReturnType<typeof appFor>, path: string, token: string) =>
    (
      await a.app.request(`${ISSUER}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).status;

  it("with auth.resource alone as the audience, a token for R or R/<surface> verifies and R/nope does not", async () => {
    const a = appFor({ authorizationServers: [EXTERNAL] });
    expect(await ping(a, "/mcp", await sign(RESOURCE))).toBe(200);
    expect(await ping(a, "/mcp/essentials", await sign(RESOURCE))).toBe(200);
    expect(await ping(a, "/mcp/essentials", await sign(urlOf("essentials")))).toBe(200);
    expect(await ping(a, "/mcp", await sign(urlOf("domain")))).toBe(200);
    expect(await ping(a, "/mcp/essentials", await sign(urlOf("nope")))).toBe(401);
    expect(await ping(a, "/mcp/essentials", await sign(`${urlOf("essentials")}X`))).toBe(401);
    expect(await ping(a, "/mcp/essentials", await sign("https://elsewhere.example/mcp"))).toBe(401);
    await a.close();
  });

  it("serves a PRM per surface naming the typed URL and the external server", async () => {
    const a = appFor({ authorizationServers: [EXTERNAL] });
    const res = await a.app.request(`${ISSUER}/mcp/essentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const prm = await a.app.request(resourceMetadataOf(res) as string);
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({
      resource: urlOf("essentials"),
      authorization_servers: [EXTERNAL],
    });
    await a.close();
  });

  it("an auth.resource that is itself a profile URL is challenged with a PRM that is served", async () => {
    const own = urlOf("essentials");
    const a = appFor({ authorizationServers: [EXTERNAL], resource: own });
    const res = await a.app.request(`${ISSUER}/mcp/essentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(resourceMetadataOf(res)).toBe(
      `${ISSUER}/.well-known/oauth-protected-resource/mcp/essentials`,
    );
    const prm = await a.app.request(resourceMetadataOf(res) as string);
    expect(prm.status).toBe(200);
    expect(((await prm.json()) as { resource: string }).resource).toBe(own);
    expect(await ping(a, "/mcp/essentials", await sign(own))).toBe(200);
    expect(await ping(a, "/mcp/essentials", await sign(`${own}/essentials`))).toBe(401);
    expect(allowedResources(own)).toEqual([own]);
    await a.close();
  });

  it("an explicit auth.audience stays exactly what the operator wrote", async () => {
    const a = appFor({ authorizationServers: [EXTERNAL], audience: RESOURCE });
    expect(await ping(a, "/mcp", await sign(RESOURCE))).toBe(200);
    expect(await ping(a, "/mcp/essentials", await sign(urlOf("essentials")))).toBe(401);
    await a.close();
    const list = appFor({
      authorizationServers: [EXTERNAL],
      audience: [RESOURCE, urlOf("essentials")],
    });
    expect(await ping(list, "/mcp/essentials", await sign(urlOf("essentials")))).toBe(200);
    expect(await ping(list, "/mcp/essentials", await sign(urlOf("core")))).toBe(401);
    await list.close();
  });
});
