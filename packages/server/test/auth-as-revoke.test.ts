// `POST /oauth/revoke` (RFC 7009; slice S6, design v2 sections 4.3 and 8): client-authenticated like the
// token endpoint, 200 for anything it cannot act on (so it is no oracle), a refresh token takes its
// whole family with it, an access token only its own jti. Discovery names the endpoint, and the
// refresh grant, only because the route is mounted.
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { AS_FEATURES, AS_ROUTES } from "../src/auth/as-metadata";
import {
  basicAuth,
  CLIENT_ID,
  cleanupFlows,
  exchange,
  type Flow,
  ISSUER,
  issue,
  LOOPBACK_CLIENT,
  makeFlow,
  mcpPing,
  refreshFields,
  revokeCall,
  SECRET_CLIENT,
  SECRET_CLIENT_SECRET,
} from "./as-flow-harness";

afterEach(cleanupFlows);

const revoke = (
  flow: Flow,
  token: string | undefined,
  extra: Record<string, string | undefined> = {},
  headers: Record<string, string> = {},
) => revokeCall(flow, { token, client_id: CLIENT_ID, ...extra }, headers);

const refreshOf = async (flow: Flow, rt: string) => (await exchange(flow, refreshFields(rt))).body;

describe("RFC 7009 answers", () => {
  it("an unknown token is 200 with an empty body, no-store, like a known one", async () => {
    const flow = await makeFlow();
    const known = await issue(flow);
    const a = await revoke(flow, "A".repeat(43));
    const b = await revoke(flow, "not.a.jwt");
    const c = await revoke(flow, known.refresh);
    for (const r of [a, b, c]) {
      expect(r.res.status).toBe(200);
      expect(r.text).toBe("");
      expect(r.res.headers.get("cache-control")).toBe("no-store");
    }
    // No information in the headers either.
    const heads = (r: Response) => JSON.stringify([...r.headers.entries()].sort());
    expect(heads(a.res)).toBe(heads(c.res));
  });

  it("revoking the same token twice is 200 both times", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    expect((await revoke(flow, a.refresh)).res.status).toBe(200);
    expect((await revoke(flow, a.refresh)).res.status).toBe(200);
  });

  it("requires the token parameter, form encoding and a known client", async () => {
    const flow = await makeFlow();
    const none = await revoke(flow, undefined);
    expect(none.res.status).toBe(400);
    expect(JSON.parse(none.text).error).toBe("invalid_request");
    const json = await flow.app.request(flow.url("/oauth/revoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x", client_id: CLIENT_ID }),
    });
    expect(json.status).toBe(415);
    const unknown = await revoke(flow, "x", { client_id: "nobody" });
    expect(unknown.res.status).toBe(401);
    expect(JSON.parse(unknown.text).error).toBe("invalid_client");
    const twice = await revokeCall(flow, { token: "x", client_id: CLIENT_ID });
    expect(twice.res.status).toBe(200);
    const body = new URLSearchParams({ client_id: CLIENT_ID });
    body.append("token", "a");
    body.append("token", "b");
    const repeated = await flow.app.request(flow.url("/oauth/revoke"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(repeated.status).toBe(400);
  });

  it("a confidential client must authenticate, and a public one must not present credentials", async () => {
    const flow = await makeFlow();
    const noSecret = await revokeCall(flow, { token: "x", client_id: SECRET_CLIENT });
    expect(noSecret.res.status).toBe(401);
    const wrong = await revokeCall(flow, { token: "x" }, basicAuth(SECRET_CLIENT, "wrong"));
    expect(wrong.res.status).toBe(401);
    const right = await revokeCall(
      flow,
      { token: "x" },
      basicAuth(SECRET_CLIENT, SECRET_CLIENT_SECRET),
    );
    expect(right.res.status).toBe(200);
    const publicWithCreds = await revokeCall(
      flow,
      { token: "x" },
      basicAuth(CLIENT_ID, "anything"),
    );
    expect(publicWithCreds.res.status).toBe(401);
  });
});

describe("revoking a refresh token", () => {
  it("revokes its family: the refresh token and every access token issued from it die", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await exchange(flow, refreshFields(a.refresh));
    const c = await exchange(flow, refreshFields(b.body.refresh_token as string));
    expect(await mcpPing(flow, c.body.access_token as string)).toBe(200);
    // Any member of the family will do: here an old one.
    expect((await revoke(flow, a.refresh)).res.status).toBe(200);
    for (const t of [a.access, b.body.access_token, c.body.access_token]) {
      expect(await mcpPing(flow, t as string)).toBe(401);
    }
    expect((await refreshOf(flow, c.body.refresh_token as string)).error).toBe("invalid_grant");
  });

  it("leaves another family of the same grant alone", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const other = await issue(flow);
    await revoke(flow, a.refresh);
    expect(await mcpPing(flow, other.access)).toBe(200);
    expect((await refreshOf(flow, other.refresh)).error).toBeUndefined();
  });

  it("honours token_type_hint only as a hint: a wrong, odd or empty hint still revokes", async () => {
    const flow = await makeFlow();
    for (const hint of ["access_token", "refresh_token", "bogus", ""]) {
      const a = await issue(flow);
      expect((await revoke(flow, a.refresh, { token_type_hint: hint })).res.status).toBe(200);
      expect((await refreshOf(flow, a.refresh)).error, `hint ${hint}`).toBe("invalid_grant");
    }
  });

  it("another client revoking it is 200 and changes nothing", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const r = await revoke(flow, a.refresh, { client_id: LOOPBACK_CLIENT });
    expect(r.res.status).toBe(200);
    expect(r.text).toBe("");
    expect(await mcpPing(flow, a.access)).toBe(200);
    expect((await refreshOf(flow, a.refresh)).error).toBeUndefined();
  });
});

describe("revoking an access token", () => {
  it("revokes that jti only: the refresh token and the other tokens still work", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await exchange(flow, refreshFields(a.refresh));
    const second = b.body.access_token as string;
    expect((await revoke(flow, a.access)).res.status).toBe(200);
    expect(await mcpPing(flow, a.access)).toBe(401);
    expect(await mcpPing(flow, second)).toBe(200);
    expect((await refreshOf(flow, b.body.refresh_token as string)).error).toBeUndefined();
    expect(flow.registry.isRevoked(decodeJwt(a.access).jti as string)).toBe(true);
  });

  it("works with the access_token hint and with the wrong hint", async () => {
    const flow = await makeFlow();
    for (const hint of ["access_token", "refresh_token"]) {
      const a = await issue(flow);
      await revoke(flow, a.access, { token_type_hint: hint });
      expect(await mcpPing(flow, a.access), hint).toBe(401);
    }
  });

  it("another client's access token, a forged one and a tampered one are 200 and revoke nothing", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const otherClient = await revoke(flow, a.access, { client_id: LOOPBACK_CLIENT });
    expect(otherClient.res.status).toBe(200);
    expect(await mcpPing(flow, a.access)).toBe(200);

    const [h, p] = a.access.split(".");
    const forged = `${h}.${p}.${"A".repeat(86)}`;
    const tampered = `${a.access.slice(0, -4)}AAAA`;
    for (const t of [forged, tampered]) {
      expect((await revoke(flow, t)).res.status).toBe(200);
    }
    expect(await mcpPing(flow, a.access)).toBe(200);
    expect(flow.registry.isRevoked(decodeJwt(a.access).jti as string)).toBe(false);
  });

  it("an expired access token is 200 and harmless", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    flow.clock.t += 3_600_000;
    expect((await revoke(flow, a.access)).res.status).toBe(200);
  });
});

describe("discovery follows the mounted routes", () => {
  const metadata = async (flow: Flow) => {
    const res = await flow.app.request(flow.url("/.well-known/oauth-authorization-server"));
    return (await res.json()) as Record<string, unknown>;
  };

  it("names revocation_endpoint and the refresh grant once the revoke route and refresh feature are registered", async () => {
    const flow = await makeFlow();
    expect(AS_ROUTES.has("revoke")).toBe(true);
    expect(AS_FEATURES.has("refresh")).toBe(true);
    const md = await metadata(flow);
    expect(md.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.scopes_supported).toContain("offline_access");
  });
});
