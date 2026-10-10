// Dynamic Client Registration behind the flag (design v2 sections 4.3, 4.7, 8 and 9; slice S8).
// Acceptance: DCR is on by default (owner decision 2026-10-09); an explicit false is a 404 and absent
// from the metadata, `hardened` forces it off, the boot notice, RFC 7591 validation and response, conformance for a native loopback client and a Cursor-shaped
// one (register -> authorize -> consent -> token -> refresh -> revoke), the flooding row (per-source
// rate limit, row cap, GC, no unbounded growth), the never-approved consent warning, and that a
// registration can never speak for a static client or a metadata-document client.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { createClientResolver } from "../src/auth/as-cimd";
import { gcOauthDb } from "../src/auth/oauth-db";
import { finalizeConfig } from "../src/config/load";
import { applySecurityProfile } from "../src/config/security-profile";
import {
  authorize,
  CLIENT_ID,
  cleanupFlows,
  consentPage,
  consentPost,
  exchange,
  type Flow,
  handleOf,
  Jar,
  loginFor,
  makeFlow,
  obtainCode,
  pkce,
  refreshFields,
  revokeCall,
  rows,
  tokenFields,
} from "./as-flow-harness";
import { openMemoryDb } from "./helpers";

afterEach(cleanupFlows);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NATIVE = "http://127.0.0.1:53124/callback";
const CURSOR = "cursor://anysphere.cursor-retrieval/oauth/user-vault/callback";
const METADATA = "/.well-known/oauth-authorization-server";

const dcrFlow = (dcr: Record<string, unknown> = {}, as: Record<string, unknown> = {}) =>
  makeFlow({ as: { dynamicRegistration: true, dcr, ...as } });

interface Registered {
  res: Response;
  body: Record<string, unknown>;
}

async function register(
  flow: Flow,
  metadata: unknown,
  headers: Record<string, string> = {},
  raw?: string,
): Promise<Registered> {
  const res = await flow.app.request(flow.url("/oauth/register"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(metadata),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON: the caller asserts on the status
  }
  return { res, body };
}

const nativeMeta = (over: Record<string, unknown> = {}) => ({
  client_name: "Native CLI",
  redirect_uris: ["http://127.0.0.1/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  ...over,
});

const cursorMeta = (over: Record<string, unknown> = {}) => ({
  client_name: "Cursor",
  redirect_uris: [CURSOR, "http://localhost:8765/oauth/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  ...over,
});

const clientRows = (flow: Flow) =>
  rows<{ client_id: string; created_ip: string | null; last_used_at: number | null }>(
    flow,
    "SELECT client_id, created_ip, last_used_at FROM oauth_clients",
  );

const ip = (addr: string) => ({ "x-test-ip": addr });

// ---- the flag ---------------------------------------------------------------------------------------

describe("DCR is on by default", () => {
  it("default: the metadata advertises registration_endpoint and /oauth/register serves", async () => {
    const flow = await makeFlow();
    const meta = (await (await flow.app.request(flow.url(METADATA))).json()) as Record<
      string,
      unknown
    >;
    expect(meta.registration_endpoint).toBe(`${flow.issuer}/oauth/register`);
    const r = await register(flow, nativeMeta());
    expect(r.res.status).toBe(201);
    expect(clientRows(flow)).toHaveLength(1);
  });

  it("explicit false: /oauth/register is a 404 and the metadata has no registration_endpoint", async () => {
    const flow = await makeFlow({ as: { dynamicRegistration: false } });
    const r = await register(flow, nativeMeta());
    expect(r.res.status).toBe(404);
    expect(clientRows(flow)).toHaveLength(0);
    const meta = (await (await flow.app.request(flow.url(METADATA))).json()) as Record<
      string,
      unknown
    >;
    expect(meta).not.toHaveProperty("registration_endpoint");
    expect(flow.logs.join("\n")).not.toMatch(/registration/i);
  });

  it("flag on: the metadata advertises registration_endpoint under the issuer", async () => {
    const flow = await dcrFlow();
    const meta = (await (await flow.app.request(flow.url(METADATA))).json()) as Record<
      string,
      unknown
    >;
    expect(meta.registration_endpoint).toBe(`${flow.issuer}/oauth/register`);
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("default: ONE concise info-level boot line names the knobs and how to turn it off", async () => {
    const flow = await makeFlow({
      as: { dcr: { maxClients: 7, perIpPerHour: 3, unusedDays: 11 } },
    });
    const notices = flow.logs.filter((l) => /dynamic client registration/i.test(l));
    expect(notices).toHaveLength(1);
    const notice = notices[0] ?? "";
    expect(notice).not.toMatch(/warning/i);
    expect(notice).toContain("/oauth/register");
    expect(notice).toContain("auth.as.dcr.perIpPerHour=3");
    expect(notice).toContain("auth.as.dcr.maxClients=7");
    expect(notice).toContain("auth.as.dcr.unusedDays=11");
    expect(notice).toContain("auth.as.dynamicRegistration: false");
  });

  it("an unclaimed server refuses registration", async () => {
    const flow = await makeFlow({ claim: false, as: { dynamicRegistration: true } });
    const r = await register(flow, nativeMeta());
    expect(r.res.status).toBe(503);
    expect(clientRows(flow)).toHaveLength(0);
  });
});

describe("the hardened security profile forces DCR off", () => {
  const base = {
    vaults: [{ id: "main", path: "/v" }],
    cacheDir: ".otc-test-cache",
    securityProfile: "hardened",
    auth: {
      mode: "jwt",
      jwtSecret: "hardened-dcr-test-secret-0123456789abcdef",
      resource: "https://vault.example.com/mcp",
      as: { enabled: true, issuer: "https://vault.example.com", dynamicRegistration: true },
    },
  };

  it("hardened with the flag unset (the new default) reads false and does not claim an override", () => {
    const { dynamicRegistration: _unset, ...as } = base.auth.as;
    const unset = { ...structuredClone(base), auth: { ...structuredClone(base.auth), as } };
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(finalizeConfig(unset, {}).auth.as?.dynamicRegistration).toBe(false);
    } finally {
      process.stderr.write = write;
    }
    expect(lines.join("")).not.toMatch(/dynamicRegistration/);
  });

  it("applySecurityProfile turns an explicit dynamicRegistration: true off", () => {
    const raw = applySecurityProfile(structuredClone(base));
    expect((raw.auth as { as: { dynamicRegistration: boolean } }).as.dynamicRegistration).toBe(
      false,
    );
  });

  it("finalizeConfig under hardened loads with DCR off and says so", () => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const cfg = finalizeConfig(structuredClone(base), {});
      expect(cfg.auth.as?.dynamicRegistration).toBe(false);
    } finally {
      process.stderr.write = write;
    }
    expect(lines.join("")).toMatch(/dynamicRegistration.*hardened/);
  });

  it("trusted-local keeps the flag as set", () => {
    const cfg = finalizeConfig({ ...structuredClone(base), securityProfile: "trusted-local" }, {});
    expect(cfg.auth.as?.dynamicRegistration).toBe(true);
  });
});

// ---- RFC 7591 validation and response ----------------------------------------------------------------

describe("registration response (RFC 7591)", () => {
  it("201 with a server-issued public client, no secret, and Cache-Control: no-store", async () => {
    const flow = await dcrFlow();
    const r = await register(flow, nativeMeta());
    expect(r.res.status).toBe(201);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.res.headers.get("content-type")).toContain("application/json");
    expect(typeof r.body.client_id).toBe("string");
    expect(r.body.client_id as string).not.toMatch(/:\/\//);
    expect(r.body.client_id_issued_at).toBe(Math.floor(flow.clock.t / 1000));
    expect(r.body.redirect_uris).toEqual(["http://127.0.0.1/callback"]);
    expect(r.body.token_endpoint_auth_method).toBe("none");
    expect(r.body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(r.body.response_types).toEqual(["code"]);
    expect(r.body.client_name).toBe("Native CLI");
    expect(r.body).not.toHaveProperty("client_secret");
    expect(r.body).not.toHaveProperty("client_secret_expires_at");
    const [row] = clientRows(flow);
    expect(row?.client_id).toBe(r.body.client_id);
  });

  it("omitted token_endpoint_auth_method, grant_types and response_types register as the public defaults", async () => {
    const flow = await dcrFlow();
    const r = await register(flow, { redirect_uris: [NATIVE] });
    expect(r.res.status).toBe(201);
    expect(r.body.token_endpoint_auth_method).toBe("none");
    expect(r.body.grant_types).toEqual(["authorization_code"]);
    expect(r.body.response_types).toEqual(["code"]);
  });

  it("a private-use scheme is dropped, not fatal, while one usable URI remains; the response lists what registered", async () => {
    const flow = await dcrFlow();
    const r = await register(flow, cursorMeta());
    expect(r.res.status).toBe(201);
    expect(r.body.redirect_uris).toEqual(["http://localhost:8765/oauth/callback"]);
    const stored = rows<{ metadata_json: string }>(flow, "SELECT metadata_json FROM oauth_clients");
    expect(stored[0]?.metadata_json).not.toContain("cursor://");
  });

  it("client_name is shown without control, format and bidi characters, and bounded", async () => {
    const flow = await dcrFlow();
    const r = await register(
      flow,
      nativeMeta({ client_name: `Evil‮gnp.exe​${"x".repeat(300)}\n<b>` }),
    );
    expect(r.res.status).toBe(201);
    const name = r.body.client_name as string;
    expect(name).not.toMatch(/[‮​\n]/);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("unknown metadata is ignored and never stored or fetched", async () => {
    const flow = await dcrFlow();
    const r = await register(
      flow,
      nativeMeta({
        logo_uri: "http://169.254.169.254/x",
        jwks_uri: "https://evil.example/jwks",
        client_uri: "https://evil.example",
        software_id: "abc",
      }),
    );
    expect(r.res.status).toBe(201);
    const stored = rows<{ metadata_json: string }>(flow, "SELECT metadata_json FROM oauth_clients");
    expect(stored[0]?.metadata_json).not.toContain("evil.example");
    expect(stored[0]?.metadata_json).not.toContain("169.254");
  });
});

describe("registration refuses what it cannot serve safely", () => {
  const cases: Array<[string, unknown, number, string]> = [
    ["no redirect_uris", { client_name: "x" }, 400, "invalid_redirect_uri"],
    ["empty redirect_uris", nativeMeta({ redirect_uris: [] }), 400, "invalid_redirect_uri"],
    [
      "redirect_uris not an array",
      nativeMeta({ redirect_uris: NATIVE }),
      400,
      "invalid_redirect_uri",
    ],
    ["a non-string redirect URI", nativeMeta({ redirect_uris: [5] }), 400, "invalid_redirect_uri"],
    [
      "more than 20 redirect URIs",
      nativeMeta({
        redirect_uris: Array.from({ length: 21 }, (_, i) => `https://a.example/cb${i}`),
      }),
      400,
      "invalid_redirect_uri",
    ],
    [
      "only a private-use scheme (nothing usable left)",
      nativeMeta({ redirect_uris: [CURSOR] }),
      400,
      "invalid_redirect_uri",
    ],
    [
      "a non-loopback http URI beside a good one",
      nativeMeta({ redirect_uris: ["http://app.example/cb", NATIVE] }),
      400,
      "invalid_redirect_uri",
    ],
    [
      "a redirect URI with credentials",
      nativeMeta({ redirect_uris: ["https://u:p@app.example/cb"] }),
      400,
      "invalid_redirect_uri",
    ],
    [
      "a redirect URI with a fragment",
      nativeMeta({ redirect_uris: ["https://app.example/cb#frag"] }),
      400,
      "invalid_redirect_uri",
    ],
    [
      "a lookalike loopback host",
      nativeMeta({ redirect_uris: ["http://localhost.evil.example/cb"] }),
      400,
      "invalid_redirect_uri",
    ],
    [
      "token_endpoint_auth_method client_secret_post",
      nativeMeta({ token_endpoint_auth_method: "client_secret_post" }),
      400,
      "invalid_client_metadata",
    ],
    [
      "token_endpoint_auth_method private_key_jwt",
      nativeMeta({ token_endpoint_auth_method: "private_key_jwt" }),
      400,
      "invalid_client_metadata",
    ],
    [
      "a non-string token_endpoint_auth_method",
      nativeMeta({ token_endpoint_auth_method: ["none"] }),
      400,
      "invalid_client_metadata",
    ],
    [
      "grant_types implicit",
      nativeMeta({ grant_types: ["authorization_code", "implicit"] }),
      400,
      "invalid_client_metadata",
    ],
    [
      "grant_types client_credentials",
      nativeMeta({ grant_types: ["client_credentials"] }),
      400,
      "invalid_client_metadata",
    ],
    [
      "grant_types without authorization_code",
      nativeMeta({ grant_types: ["refresh_token"] }),
      400,
      "invalid_client_metadata",
    ],
    [
      "response_types token",
      nativeMeta({ response_types: ["token"] }),
      400,
      "invalid_client_metadata",
    ],
    [
      "a non-string client_name",
      nativeMeta({ client_name: { a: 1 } }),
      400,
      "invalid_client_metadata",
    ],
    ["a JSON array body", [nativeMeta()], 400, "invalid_client_metadata"],
  ];

  it.each(cases)("%s", async (_n, body, status, error) => {
    const flow = await dcrFlow();
    const r = await register(flow, body);
    expect(r.res.status).toBe(status);
    expect(r.body.error).toBe(error);
    expect(typeof r.body.error_description).toBe("string");
    expect(clientRows(flow)).toHaveLength(0);
  });

  it("a body that is not JSON is invalid_client_metadata", async () => {
    const flow = await dcrFlow();
    const r = await register(flow, undefined, {}, "{not json");
    expect(r.res.status).toBe(400);
    expect(r.body.error).toBe("invalid_client_metadata");
  });

  it("a form-encoded body is 415", async () => {
    const flow = await dcrFlow();
    const r = await register(
      flow,
      undefined,
      { "content-type": "application/x-www-form-urlencoded" },
      "redirect_uris=x",
    );
    expect(r.res.status).toBe(415);
  });

  it("GET is not a registration", async () => {
    const flow = await dcrFlow();
    const res = await flow.app.request(flow.url("/oauth/register"));
    expect(res.status).toBe(404);
  });
});

// ---- conformance --------------------------------------------------------------------------------------

describe("conformance: register -> authorize -> consent -> token -> refresh -> revoke", () => {
  async function walk(flow: Flow, meta: unknown, redirect: string) {
    const reg = await register(flow, meta);
    expect(reg.res.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {
      client_id: clientId,
      redirect_uri: redirect,
    });
    expect(code).not.toBe("");
    const issued = await exchange(
      flow,
      tokenFields(code, verifier, { client_id: clientId, redirect_uri: redirect }),
    );
    expect(issued.res.status).toBe(200);
    expect(issued.body.token_type).toBe("Bearer");
    const refreshed = await exchange(
      flow,
      refreshFields(issued.body.refresh_token as string, {
        client_id: clientId,
        resource: undefined,
      }),
    );
    expect(refreshed.res.status).toBe(200);
    const next = refreshed.body.refresh_token as string;
    expect(next).not.toBe(issued.body.refresh_token);
    expect((await revokeCall(flow, { token: next, client_id: clientId })).res.status).toBe(200);
    const dead = await exchange(
      flow,
      refreshFields(next, { client_id: clientId, resource: undefined }),
    );
    expect(dead.body.error).toBe("invalid_grant");
    return clientId;
  }

  it("a native loopback client (the port chosen at run time differs from the registered one)", async () => {
    const flow = await dcrFlow();
    await walk(flow, nativeMeta(), NATIVE);
  });

  it("a Cursor-shaped client: cursor:// dropped, loopback kept, flow completes", async () => {
    const flow = await dcrFlow();
    await walk(flow, cursorMeta(), "http://localhost:51234/oauth/callback");
  });

  it("the dropped private-use redirect is not usable at authorize: a local error, no redirect", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, cursorMeta());
    const res = await authorize(flow, new Jar(), pkce().challenge, {
      client_id: reg.body.client_id as string,
      redirect_uri: CURSOR,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a completed sign-in stamps last_used_at (throttled), and no lookup does", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, nativeMeta());
    const clientId = reg.body.client_id as string;
    expect(clientRows(flow)[0]?.last_used_at).toBeNull();
    flow.clock.t += 2 * HOUR;
    // Looked up, never used: a redirect that is not the client's.
    await authorize(flow, new Jar(), pkce().challenge, {
      client_id: clientId,
      redirect_uri: "https://elsewhere.example/cb",
    });
    expect(clientRows(flow)[0]?.last_used_at).toBeNull();
    // Used: a code was issued.
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {
      client_id: clientId,
      redirect_uri: NATIVE,
    });
    expect(code).not.toBe("");
    const issuedAt = flow.clock.t;
    expect(clientRows(flow)[0]?.last_used_at).toBe(issuedAt);
    // The exchange inside the hour writes nothing more; a refresh two hours on is a use again.
    const issued = await exchange(
      flow,
      tokenFields(code, verifier, { client_id: clientId, redirect_uri: NATIVE }),
    );
    expect(issued.res.status).toBe(200);
    expect(clientRows(flow)[0]?.last_used_at).toBe(issuedAt);
    flow.clock.t += 2 * HOUR;
    const refreshed = await exchange(
      flow,
      refreshFields(issued.body.refresh_token as string, {
        client_id: clientId,
        resource: undefined,
      }),
    );
    expect(refreshed.res.status).toBe(200);
    expect(clientRows(flow)[0]?.last_used_at).toBe(flow.clock.t);
  });
});

describe("a failed lookup is not a use (it cannot defeat reclamation)", () => {
  const noUse = async (flow: Flow, clientId: string) => {
    flow.clock.t += 2 * HOUR;
    // authorize: a redirect the client never registered
    await authorize(flow, new Jar(), pkce().challenge, {
      client_id: clientId,
      redirect_uri: "junk",
    });
    await authorize(flow, new Jar(), pkce().challenge, {
      client_id: clientId,
      redirect_uri: "https://elsewhere.example/cb",
    });
    // token: a code nobody issued, and a refresh token nobody issued
    const fake = await exchange(
      flow,
      tokenFields("not-a-code", pkce().verifier, { client_id: clientId, redirect_uri: NATIVE }),
    );
    expect(fake.body.error).toBe("invalid_grant");
    const stale = await exchange(
      flow,
      refreshFields("not-a-refresh-token", { client_id: clientId, resource: undefined }),
    );
    expect(stale.body.error).toBe("invalid_grant");
    // revoke: a token nobody issued
    expect((await revokeCall(flow, { token: "junk", client_id: clientId })).res.status).toBe(200);
  };

  it("failed authorize, failed token and failed revoke leave last_used_at unset", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, nativeMeta());
    await noUse(flow, reg.body.client_id as string);
    expect(clientRows(flow)[0]?.last_used_at).toBeNull();
  });

  it("a full table still reclaims rows that were only ever looked up", async () => {
    const flow = await dcrFlow({ maxClients: 2 });
    const a = await register(flow, nativeMeta(), ip("198.51.100.70"));
    const b = await register(flow, nativeMeta(), ip("198.51.100.71"));
    await noUse(flow, a.body.client_id as string);
    await noUse(flow, b.body.client_id as string);
    flow.clock.t += 25 * HOUR;
    const fresh = await register(flow, nativeMeta(), ip("198.51.100.72"));
    expect(fresh.res.status).toBe(201);
    expect(clientRows(flow).map((r) => r.client_id)).toEqual([fresh.body.client_id]);
  });
});

describe("grant_types is honored", () => {
  async function signIn(flow: Flow, meta: unknown) {
    const reg = await register(flow, meta);
    expect(reg.res.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {
      client_id: clientId,
      redirect_uri: NATIVE,
    });
    const issued = await exchange(
      flow,
      tokenFields(code, verifier, { client_id: clientId, redirect_uri: NATIVE }),
    );
    expect(issued.res.status).toBe(200);
    return { reg, issued };
  }

  it("an authorization_code-only client gets no refresh token, and the 201 says so", async () => {
    const flow = await dcrFlow();
    const { reg, issued } = await signIn(flow, nativeMeta({ grant_types: ["authorization_code"] }));
    expect(reg.body.grant_types).toEqual(["authorization_code"]);
    expect(issued.body.access_token).toBeTruthy();
    expect(issued.body).not.toHaveProperty("refresh_token");
    expect(rows(flow, "SELECT 1 FROM refresh_tokens")).toHaveLength(0);
  });

  it("a client that omits grant_types gets the RFC 7591 default: no refresh token", async () => {
    const flow = await dcrFlow();
    const { reg, issued } = await signIn(flow, { redirect_uris: [NATIVE] });
    expect(reg.body.grant_types).toEqual(["authorization_code"]);
    expect(issued.body).not.toHaveProperty("refresh_token");
  });

  it("a client that registers both gets a refresh token", async () => {
    const flow = await dcrFlow();
    const { reg, issued } = await signIn(flow, nativeMeta());
    expect(reg.body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(typeof issued.body.refresh_token).toBe("string");
  });

  it("a static client keeps its refresh token", async () => {
    const flow = await dcrFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge);
    const issued = await exchange(flow, tokenFields(code, verifier));
    expect(typeof issued.body.refresh_token).toBe("string");
  });
});

// ---- flooding -----------------------------------------------------------------------------------------

describe("DCR flooding", () => {
  it("the 11th registration in an hour from one source is 429 with Retry-After; another source still registers", async () => {
    const flow = await dcrFlow();
    for (let i = 0; i < 10; i++) {
      expect((await register(flow, nativeMeta(), ip("198.51.100.7"))).res.status).toBe(201);
    }
    const refused = await register(flow, nativeMeta(), ip("198.51.100.7"));
    expect(refused.res.status).toBe(429);
    expect(Number(refused.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.body.error).toBe("temporarily_unavailable");
    expect(clientRows(flow)).toHaveLength(10);
    expect((await register(flow, nativeMeta(), ip("198.51.100.8"))).res.status).toBe(201);
  });

  it("an invalid request spends the same budget (the limit sits before validation)", async () => {
    const flow = await dcrFlow({ perIpPerHour: 2 });
    const a = ip("198.51.100.9");
    expect((await register(flow, {}, a)).res.status).toBe(400);
    expect((await register(flow, {}, a)).res.status).toBe(400);
    expect((await register(flow, nativeMeta(), a)).res.status).toBe(429);
  });

  it("an IPv6 address counts as its /64: rotating inside one does not buy a new budget", async () => {
    const flow = await dcrFlow({ perIpPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await register(flow, nativeMeta(), ip(`2001:db8:1:2:${i + 1}::1`))).res.status).toBe(
        201,
      );
    }
    expect((await register(flow, nativeMeta(), ip("2001:db8:1:2:ffff::9"))).res.status).toBe(429);
    expect((await register(flow, nativeMeta(), ip("2001:db8:1:3::1"))).res.status).toBe(201);
  });

  it("peers with no usable address share one fallback bucket; a real address still registers", async () => {
    const flow = await dcrFlow({ perIpPerHour: 2 });
    expect((await register(flow, nativeMeta())).res.status).toBe(201);
    expect((await register(flow, nativeMeta(), ip("unknown"))).res.status).toBe(201);
    expect((await register(flow, nativeMeta())).res.status).toBe(429);
    expect((await register(flow, nativeMeta(), ip("198.51.100.20"))).res.status).toBe(201);
  });

  it("the budget refills over the hour, and idling a few minutes does not reset it", async () => {
    const flow = await dcrFlow({ perIpPerHour: 10 });
    const a = ip("198.51.100.30");
    for (let i = 0; i < 10; i++) await register(flow, nativeMeta(), a);
    expect((await register(flow, nativeMeta(), a)).res.status).toBe(429);
    // 15 minutes at 10 an hour earns 2 registrations, not a fresh 10: an idle sweep must not reset a bucket.
    flow.clock.t += 15 * 60_000;
    // Another source's request is what runs the backend's idle sweep.
    expect((await register(flow, nativeMeta(), ip("198.51.100.31"))).res.status).toBe(201);
    expect((await register(flow, nativeMeta(), a)).res.status).toBe(201);
    expect((await register(flow, nativeMeta(), a)).res.status).toBe(201);
    expect((await register(flow, nativeMeta(), a)).res.status).toBe(429);
    flow.clock.t += HOUR;
    expect((await register(flow, nativeMeta(), a)).res.status).toBe(201);
  });

  it("at the row cap a registration is 503 with a clear error, and the table never grows past the cap", async () => {
    const flow = await dcrFlow({ maxClients: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await register(flow, nativeMeta(), ip(`198.51.100.${40 + i}`))).res.status).toBe(201);
    }
    const full = await register(flow, nativeMeta(), ip("198.51.100.99"));
    expect(full.res.status).toBe(503);
    expect(full.body.error).toBe("temporarily_unavailable");
    expect(full.body.error_description).toMatch(/limit/i);
    expect(clientRows(flow)).toHaveLength(3);
  });

  it("a full table reclaims registrations never used within a day, but never a used one", async () => {
    const flow = await dcrFlow({ maxClients: 2 });
    const used = await register(flow, nativeMeta(), ip("198.51.100.50"));
    const stale = await register(flow, nativeMeta(), ip("198.51.100.51"));
    flow.clock.t += 2 * HOUR;
    await obtainCode(flow, new Jar(), pkce().challenge, {
      client_id: used.body.client_id as string,
      redirect_uri: NATIVE,
    });
    flow.clock.t += 25 * HOUR;
    const fresh = await register(flow, nativeMeta(), ip("198.51.100.52"));
    expect(fresh.res.status).toBe(201);
    const ids = clientRows(flow).map((r) => r.client_id);
    expect(ids).toContain(used.body.client_id);
    expect(ids).toContain(fresh.body.client_id);
    expect(ids).not.toContain(stale.body.client_id);
    // Both left are live (one used, one new): the next one is refused.
    expect((await register(flow, nativeMeta(), ip("198.51.100.53"))).res.status).toBe(503);
  });

  it("housekeeping deletes a registration unused for unusedDays and keeps a used one", async () => {
    const flow = await dcrFlow({ unusedDays: 90 });
    const kept = await register(flow, nativeMeta(), ip("198.51.100.60"));
    const idle = await register(flow, nativeMeta(), ip("198.51.100.61"));
    flow.clock.t += 60 * DAY;
    await obtainCode(flow, new Jar(), pkce().challenge, {
      client_id: kept.body.client_id as string,
      redirect_uri: NATIVE,
    });
    const later = flow.clock.t + 40 * DAY;
    const counts = gcOauthDb(flow.db, { now: later, dcrUnusedDays: 90 });
    expect(counts.dcrClients).toBe(1);
    const ids = clientRows(flow).map((r) => r.client_id);
    expect(ids).toEqual([kept.body.client_id]);
    expect(ids).not.toContain(idle.body.client_id);
  });

  it("the source recorded with a registration is the bucket key, never a raw header", async () => {
    const flow = await dcrFlow();
    await register(flow, nativeMeta(), {
      ...ip("198.51.100.70"),
      "x-forwarded-for": "203.0.113.5",
    });
    expect(clientRows(flow)[0]?.created_ip).toBe("v4:198.51.100.70");
  });
});

// ---- identity ----------------------------------------------------------------------------------------

describe("a registration cannot speak for another client", () => {
  it("a client_id in the request is ignored: a static id or a CIMD URL is never issued, and the static client is unchanged", async () => {
    const flow = await dcrFlow();
    for (const wanted of [CLIENT_ID, "https://claude.ai/oauth/claude-code-client-metadata"]) {
      const r = await register(
        flow,
        nativeMeta({ client_id: wanted, redirect_uris: ["https://evil.example/cb"] }),
      );
      expect(r.res.status).toBe(201);
      expect(r.body.client_id).not.toBe(wanted);
    }
    // The static client still redirects only to its own URI.
    const res = await authorize(flow, new Jar(), pkce().challenge, {
      client_id: CLIENT_ID,
      redirect_uri: "https://evil.example/cb",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a registered client's redirect list is its own: another client's URI is a local error", async () => {
    const flow = await dcrFlow();
    const a = await register(flow, nativeMeta({ redirect_uris: ["https://a.example/cb"] }));
    const res = await authorize(flow, new Jar(), pkce().challenge, {
      client_id: a.body.client_id as string,
      redirect_uri: "https://b.example/cb",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("registered clients resolve only while the flag is on, and only by an exact id", () => {
    const db = openMemoryDb();
    db.exec(
      "CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, created_ip TEXT)",
    );
    db.prepare("INSERT INTO oauth_clients VALUES ('dcr_abc', 'dcr', ?, 1, NULL, NULL, NULL)").run(
      JSON.stringify({ name: "n", redirectUris: ["https://a.example/cb"] }),
    );
    const deps = {
      clients: [],
      allowedHosts: [],
      db,
      now: () => 10,
      log: () => {},
    };
    const on = createClientResolver({ ...deps, dynamicRegistration: true });
    const off = createClientResolver({ ...deps, dynamicRegistration: false });
    return Promise.all([
      on("dcr_abc").then((r) => expect("client" in r).toBe(true)),
      on("dcr_ab").then((r) => expect("client" in r).toBe(false)),
      off("dcr_abc").then((r) => expect("client" in r).toBe(false)),
    ]);
  });
});

// ---- consent ------------------------------------------------------------------------------------------

describe("consent for a registered client", () => {
  async function consentFor(flow: Flow, clientId: string, jar: Jar, redirect = NATIVE) {
    const a = await authorize(flow, jar, pkce().challenge, {
      client_id: clientId,
      redirect_uri: redirect,
    });
    const next = a.headers.get("location") ?? "";
    if (next.startsWith("/oauth/login")) await loginFor(flow, jar, next);
    return { page: await consentPage(flow, jar, handleOf(next)), next };
  }

  it("shows the never-approved warning, the loopback warning and the name, until the operator approves", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, nativeMeta());
    const clientId = reg.body.client_id as string;
    const jar = new Jar();
    const { page } = await consentFor(flow, clientId, jar);
    expect(page.seen.res.status).toBe(200);
    expect(page.seen.text).toContain("registered itself");
    expect(page.seen.text).toContain("you have not approved it before");
    expect(page.seen.text).toContain("returns to an address on the computer");
    expect(page.seen.text).toContain("Native CLI");
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(done.res.status).toBe(303);
    // Approved: the next sign-in is remembered (loopback default), and a wider scope asks again
    // without the first-time warning.
    const wider = await authorize(flow, jar, pkce().challenge, {
      client_id: clientId,
      redirect_uri: NATIVE,
      scope: "read:notes write:notes",
    });
    const again = await consentPage(flow, jar, handleOf(wider.headers.get("location")));
    expect(again.seen.res.status).toBe(200);
    expect(again.seen.text).not.toContain("you have not approved it before");
  });

  it("an identical second registration is a different client: it has no remembered consent and shows the warning", async () => {
    const flow = await dcrFlow();
    const first = await register(flow, nativeMeta());
    const second = await register(flow, nativeMeta());
    expect(second.body.client_id).not.toBe(first.body.client_id);
    const jar = new Jar();
    const one = await consentFor(flow, first.body.client_id as string, jar);
    await consentPost(flow, jar, {
      csrf: one.page.csrf,
      request: one.page.request,
      decision: "approve",
    });
    const two = await consentFor(flow, second.body.client_id as string, jar);
    expect(two.page.seen.res.status).toBe(200);
    expect(two.page.seen.text).toContain("you have not approved it before");
  });

  it("an unnamed client is shown as unnamed, and a static client has no registration warning", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, { redirect_uris: ["https://app.example/cb"] });
    const jar = new Jar();
    const { page } = await consentFor(
      flow,
      reg.body.client_id as string,
      jar,
      "https://app.example/cb",
    );
    expect(page.seen.text).toContain("Unnamed application");
    const staticJar = new Jar();
    const a = await authorize(flow, staticJar, pkce().challenge);
    const next = a.headers.get("location") ?? "";
    await loginFor(flow, staticJar, next);
    const sp = await consentPage(flow, staticJar, handleOf(next));
    expect(sp.seen.text).not.toContain("registered itself");
  });
});

describe("the schema keys the slice reads", () => {
  it("defaults: on, 1000 clients, 10 per source per hour, 90 days", () => {
    const cfg = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: {
        mode: "jwt",
        jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
        resource: "https://vault.example.com/mcp",
        as: { enabled: true, issuer: "https://vault.example.com" },
      },
    });
    expect(cfg.auth.as?.dynamicRegistration).toBe(true);
    expect(cfg.auth.as?.dcr).toEqual({ maxClients: 1000, perIpPerHour: 10, unusedDays: 90 });
  });
});
