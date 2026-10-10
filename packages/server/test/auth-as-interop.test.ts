// Interop fixes of the bundled authorization server found by surveying real MCP clients (Le Chat,
// Perplexity, older Antigravity, claude.ai, grok.com, Muse Code): full RFC 7591 metadata at /register, one
// trailing slash on `resource`, short authorization codes, the token endpoint's shape and speed and error
// codes, a scope vocabulary that lists more than `offline_access`, grok.com's callback, and a confidential
// client registered through DCR.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { matchResource } from "../src/auth/resource-set";
import {
  authorize,
  cleanupFlows,
  exchange,
  type Flow,
  ISSUER,
  Jar,
  makeFlow,
  obtainCode,
  pkce,
  RESOURCE,
  refreshFields,
  revokeCall,
  rows,
  tokenFields,
} from "./as-flow-harness";

afterEach(cleanupFlows);

const NATIVE = "http://127.0.0.1:53124/callback";
const GROK = "https://grok.com/connectors-oauth-exchange-code/";
const dcrFlow = () => makeFlow({ as: { dynamicRegistration: true } });

async function register(flow: Flow, metadata: unknown) {
  const res = await flow.app.request(flow.url("/oauth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

const basic = (id: string, secret: string) => ({
  authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
});

describe("1. /register accepts the full RFC 7591 metadata a client like Le Chat sends", () => {
  // The member set a hosted client sends: every RFC 7591 section 2 member, some with shapes a strict
  // server would trip on. None is stored, fetched or rendered; the response lists what registered.
  const leChat = {
    client_name: "Le Chat",
    redirect_uris: ["https://chat.mistral.ai/connectors/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "read:notes offline_access",
    token_endpoint_auth_method: "none",
    client_uri: "https://mistral.ai",
    logo_uri: "https://mistral.ai/logo.png",
    tos_uri: "https://mistral.ai/terms",
    policy_uri: "https://mistral.ai/privacy",
    contacts: ["support@mistral.ai"],
    software_id: "le-chat",
    software_version: "2026.10",
    jwks_uri: "https://mistral.ai/jwks.json",
    jwks: { keys: [] },
    software_statement: "eyJhbGciOiJub25lIn0.e30.",
    application_type: "web",
    "client_name#fr": "Le Chat",
    x_vendor_extension: { nested: [1, 2, 3] },
  };

  it("registers it (201) and echoes only what it registered", async () => {
    const flow = await dcrFlow();
    const r = await register(flow, leChat);
    expect(r.res.status).toBe(201);
    expect(r.body.redirect_uris).toEqual(leChat.redirect_uris);
    expect(r.body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(r.body.client_name).toBe("Le Chat");
    for (const ignored of ["client_uri", "logo_uri", "jwks_uri", "jwks", "software_statement"]) {
      expect(r.body, ignored).not.toHaveProperty(ignored);
    }
    const stored = rows<{ metadata_json: string }>(flow, "SELECT metadata_json FROM oauth_clients");
    expect(stored[0]?.metadata_json).not.toContain("mistral.ai/logo");
  });

  it("members the server ignores never fail the registration, whatever their JSON type", async () => {
    const flow = await dcrFlow();
    for (const over of [
      { contacts: "not-a-list" },
      { jwks: "nope" },
      { client_uri: 5 },
      { logo_uri: null },
      { scope: ["read:notes"] },
      { software_version: { v: 1 } },
      { tos_uri: "javascript:alert(1)" },
    ]) {
      const r = await register(flow, { ...leChat, ...over });
      expect(r.res.status, JSON.stringify(over)).toBe(201);
    }
  });
});

describe("2. one trailing slash on `resource` is the same resource, canonicalised to the member", () => {
  it("matchResource accepts exactly one trailing slash on a member and returns the member", () => {
    expect(matchResource(`${RESOURCE}/`, RESOURCE)).toBe(RESOURCE);
    expect(matchResource(`${RESOURCE}/essentials/`, RESOURCE)).toBe(`${RESOURCE}/essentials`);
    expect(matchResource("HTTPS://VAULT.EXAMPLE.COM/mcp/", RESOURCE)).toBe(RESOURCE);
    // a root resource: the URL parser already adds the slash
    expect(matchResource("https://vault.example.com/", "https://vault.example.com")).toBe(
      "https://vault.example.com",
    );
    for (const bad of [
      `${RESOURCE}//`,
      `${RESOURCE}///`,
      `${RESOURCE}\\`,
      `${RESOURCE}\\/`,
      `${RESOURCE}/ `,
      `${RESOURCE}/?`,
      `${RESOURCE}/#`,
      `${RESOURCE}/x/`,
      `${RESOURCE}%2F`,
      `${RESOURCE}x/`,
      "https://vault.example.com//mcp/",
      "",
      "/",
    ]) {
      expect(matchResource(bad, RESOURCE), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("authorize, code exchange and refresh accept it, and aud stays canonical", async () => {
    const flow = await makeFlow();
    const slash = `${RESOURCE}/`;
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, { resource: slash });
    expect(code).not.toBe("");
    const issued = await exchange(flow, tokenFields(code, verifier, { resource: slash }));
    expect(issued.res.status).toBe(200);
    expect(decodeJwt(issued.body.access_token as string).aud).toBe(RESOURCE);
    const refreshed = await exchange(
      flow,
      refreshFields(issued.body.refresh_token as string, { resource: slash }),
    );
    expect(refreshed.res.status).toBe(200);
    expect(decodeJwt(refreshed.body.access_token as string).aud).toBe(RESOURCE);
  });

  it("two trailing slashes are still invalid_target at authorize and at the token endpoint", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const bad = await authorize(flow, new Jar(), challenge, { resource: `${RESOURCE}//` });
    expect(new URL(bad.headers.get("location") ?? "", ISSUER).searchParams.get("error")).toBe(
      "invalid_target",
    );
    const { code } = await obtainCode(flow, new Jar(), challenge, {});
    const r = await exchange(flow, tokenFields(code, verifier, { resource: `${RESOURCE}//` }));
    expect(r.body.error).toBe("invalid_target");
  });
});

describe("3. authorization codes stay under 1024 characters (older Antigravity)", () => {
  it("a code is 43 base64url characters", async () => {
    const flow = await makeFlow();
    const { challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {});
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code.length).toBeLessThan(1024);
  });
});

describe("4. the token endpoint", () => {
  it("answers the happy path in well under the 10 s a hosted client allows", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {});
    const t0 = performance.now();
    const issued = await exchange(flow, tokenFields(code, verifier));
    const exchangeMs = performance.now() - t0;
    expect(issued.res.status).toBe(200);
    const t1 = performance.now();
    const refreshed = await exchange(flow, refreshFields(issued.body.refresh_token as string, {}));
    const refreshMs = performance.now() - t1;
    expect(refreshed.res.status).toBe(200);
    expect(exchangeMs).toBeLessThan(2000);
    expect(refreshMs).toBeLessThan(2000);
  });

  it("takes application/x-www-form-urlencoded (with a charset); JSON is refused as invalid_request", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {});
    const fields = tokenFields(code, verifier);
    const json = await flow.app.request(flow.url("/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
    expect(json.status).toBe(415);
    expect(((await json.json()) as { error: string }).error).toBe("invalid_request");
    const form = await exchange(flow, fields, {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    });
    expect(form.res.status).toBe(200);
  });

  it("is invalid_grant for an unknown, reused or expired code and for a dead refresh token", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const unknown = await exchange(flow, tokenFields("x".repeat(43), verifier));
    expect([unknown.res.status, unknown.body.error]).toEqual([400, "invalid_grant"]);

    const { code } = await obtainCode(flow, new Jar(), challenge, {});
    const first = await exchange(flow, tokenFields(code, verifier));
    expect(first.res.status).toBe(200);
    const reused = await exchange(flow, tokenFields(code, verifier));
    expect([reused.res.status, reused.body.error]).toEqual([400, "invalid_grant"]);

    const p2 = pkce();
    const second = await obtainCode(flow, new Jar(), p2.challenge, {});
    flow.clock.t += 61_000;
    const expired = await exchange(flow, tokenFields(second.code, p2.verifier));
    expect([expired.res.status, expired.body.error]).toEqual([400, "invalid_grant"]);

    for (const token of ["y".repeat(43), "not-a-token", first.body.refresh_token as string]) {
      const r = await exchange(flow, refreshFields(token, {}));
      expect([r.res.status, r.body.error], token).toEqual([400, "invalid_grant"]);
    }
  });

  it("uses the other RFC 6749 section 5.2 codes where they belong", async () => {
    const flow = await makeFlow();
    const { verifier } = pkce();
    const cases: Array<[Record<string, string | undefined>, number, string]> = [
      [{ grant_type: undefined }, 400, "invalid_request"],
      [{ grant_type: "password" }, 400, "unsupported_grant_type"],
      [{ code: undefined }, 400, "invalid_request"],
      [{ redirect_uri: undefined }, 400, "invalid_request"],
      [{ client_id: "nobody" }, 401, "invalid_client"],
      [{ client_id: undefined }, 401, "invalid_client"],
      [{ resource: "https://evil.example/mcp" }, 400, "invalid_target"],
    ];
    for (const [over, status, error] of cases) {
      const r = await exchange(flow, tokenFields("c".repeat(43), verifier, over));
      expect([r.res.status, r.body.error], JSON.stringify(over)).toEqual([status, error]);
    }
    const noToken = await exchange(flow, refreshFields(undefined, {}));
    expect([noToken.res.status, noToken.body.error]).toEqual([400, "invalid_request"]);
  });
});

describe("5. scopes_supported lists the scope vocabulary, not offline_access alone", () => {
  const prmOf = async (flow: Flow) =>
    (await (
      await flow.app.request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as { scopes_supported?: string[] };
  const asOf = async (flow: Flow) =>
    (await (await flow.app.request(`${ISSUER}/.well-known/oauth-authorization-server`)).json()) as {
      scopes_supported: string[];
    };

  it("with auth.scopesSupported unset, AS metadata, PRM and the challenge carry read:* and write:*", async () => {
    const flow = await makeFlow();
    expect((await asOf(flow)).scopes_supported).toEqual(["read:*", "write:*", "offline_access"]);
    expect((await prmOf(flow)).scopes_supported).toEqual(["read:*", "write:*"]);
    const challenge = await flow.app.request(`${ISSUER}/mcp`, { method: "POST" });
    expect(challenge.headers.get("www-authenticate")).toContain('scope="read:* write:*"');
  });

  it("an operator's auth.scopesSupported replaces the default everywhere", async () => {
    const flow = await makeFlow({ scopesSupported: ["read:notes"] });
    expect((await asOf(flow)).scopes_supported).toEqual(["read:notes", "offline_access"]);
    expect((await prmOf(flow)).scopes_supported).toEqual(["read:notes"]);
  });

  it("the advertised default is not the grant default: a client that names no scope still gets read only", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, { scope: undefined });
    const r = await exchange(flow, tokenFields(code, verifier));
    expect(r.body.scope).toBe("read:*");
  });
});

describe("6. grok.com's callback, with its trailing slash, is a usable redirect URI", () => {
  it("registers exactly, authorizes with exactly that URI, and refuses the slash-less variant", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, {
      client_name: "Grok",
      redirect_uris: [GROK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(reg.res.status).toBe(201);
    expect(reg.body.redirect_uris).toEqual([GROK]);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();
    const { code, location } = await obtainCode(flow, new Jar(), challenge, {
      client_id: clientId,
      redirect_uri: GROK,
    });
    expect(location.startsWith(GROK)).toBe(true);
    const r = await exchange(
      flow,
      tokenFields(code, verifier, { client_id: clientId, redirect_uri: GROK }),
    );
    expect(r.res.status).toBe(200);
    const off = await authorize(flow, new Jar(), challenge, {
      client_id: clientId,
      redirect_uri: GROK.slice(0, -1),
    });
    expect(off.status).toBe(400);
    expect(off.headers.get("location")).toBeNull();
  });
});

describe("7. a confidential client registered through DCR (client_secret_basic)", () => {
  const meta = {
    client_name: "Muse Code",
    redirect_uris: [NATIVE],
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };

  it("is issued a secret once, and the response says so (RFC 7591 section 3.2.1)", async () => {
    const flow = await dcrFlow();
    const r = await register(flow, meta);
    expect(r.res.status).toBe(201);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(r.body.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.client_secret_expires_at).toBe(0);
    const stored = JSON.stringify(rows(flow, "SELECT * FROM oauth_clients"));
    expect(stored).not.toContain(r.body.client_secret as string);
    expect(stored).toContain(
      createHash("sha256")
        .update(r.body.client_secret as string)
        .digest("hex"),
    );
  });

  it("two registrations never share a secret", async () => {
    const flow = await dcrFlow();
    const a = await register(flow, meta);
    const b = await register(flow, meta);
    expect(a.body.client_secret).not.toBe(b.body.client_secret);
  });

  it("walks register -> authorize -> token -> refresh -> revoke, authenticating each call", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, meta);
    const id = reg.body.client_id as string;
    const secret = reg.body.client_secret as string;
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {
      client_id: id,
      redirect_uri: NATIVE,
    });
    const fields = tokenFields(code, verifier, { client_id: undefined, redirect_uri: NATIVE });
    // no credentials, a wrong secret, the secret in the body, another registration's secret: refused
    const other = (await register(flow, meta)).body.client_secret as string;
    for (const headers of [{}, basic(id, "wrong"), basic(id, other), basic(id, "")]) {
      const r = await exchange(flow, { ...fields, client_id: id }, headers);
      expect([r.res.status, r.body.error]).toEqual([401, "invalid_client"]);
    }
    const inBody = await exchange(flow, { ...fields, client_id: id, client_secret: secret });
    expect(inBody.body.error).toBe("invalid_client");
    // the refused attempts did not spend the code
    const issued = await exchange(flow, fields, basic(id, secret));
    expect(issued.res.status).toBe(200);
    expect(decodeJwt(issued.body.access_token as string).client_id).toBe(id);
    const refreshFor = (t: string) => refreshFields(t, { client_id: undefined });
    const bare = await exchange(flow, refreshFor(issued.body.refresh_token as string));
    expect(bare.body.error).toBe("invalid_client");
    const refreshed = await exchange(
      flow,
      refreshFor(issued.body.refresh_token as string),
      basic(id, secret),
    );
    expect(refreshed.res.status).toBe(200);
    const next = refreshed.body.refresh_token as string;
    expect((await revokeCall(flow, { token: next })).res.status).toBe(401);
    expect((await revokeCall(flow, { token: next }, basic(id, secret))).res.status).toBe(200);
  });

  it("a public registration still refuses credentials", async () => {
    const flow = await dcrFlow();
    const reg = await register(flow, { ...meta, token_endpoint_auth_method: "none" });
    expect(reg.body).not.toHaveProperty("client_secret");
    const id = reg.body.client_id as string;
    const r = await exchange(
      flow,
      refreshFields("z".repeat(43), { client_id: id }),
      basic(id, "x"),
    );
    expect(r.body.error).toBe("invalid_client");
  });

  it("other secret-bearing methods are still refused, naming what is served", async () => {
    const flow = await dcrFlow();
    for (const m of ["client_secret_post", "private_key_jwt", "tls_client_auth"]) {
      const r = await register(flow, { ...meta, token_endpoint_auth_method: m });
      expect([r.res.status, r.body.error], m).toEqual([400, "invalid_client_metadata"]);
      expect(r.body.error_description).toContain("client_secret_basic");
    }
  });

  it("the metadata lists client_secret_basic only while DCR can issue it", async () => {
    const only = [{ clientId: "pub", name: "Pub", redirectUris: ["https://app.example/cb"] }];
    const methods = async (dynamicRegistration: boolean) => {
      const flow = await makeFlow({ as: { dynamicRegistration, clients: only } });
      const m = (await (
        await flow.app.request(`${ISSUER}/.well-known/oauth-authorization-server`)
      ).json()) as { token_endpoint_auth_methods_supported: string[] };
      return m.token_endpoint_auth_methods_supported;
    };
    expect(await methods(true)).toEqual(["none", "client_secret_basic"]);
    expect(await methods(false)).toEqual(["none"]);
  });
});
