// `POST /oauth/token`, authorization_code grant (slice S5; design v2 sections 4.3, 4.4 and 8): PKCE
// downgrade, code injection and replay, audience, client binding, and what is recorded before a token
// may leave.
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gcOauthDb } from "../src/auth/oauth-db";
import {
  CLIENT_ID,
  cleanupFlows,
  exchange,
  ISSUER,
  Jar,
  LOOPBACK_CLIENT,
  makeFlow,
  mcpPing,
  obtainCode,
  pkce,
  RESOURCE,
  rows,
  SECRET_CLIENT,
  SECRET_CLIENT_SECRET,
  tokenFields,
} from "./as-flow-harness";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFlows();
});

async function codeFor(flow: Awaited<ReturnType<typeof makeFlow>>, over = {}) {
  const { verifier, challenge } = pkce();
  const { code } = await obtainCode(flow, new Jar(), challenge, over);
  expect(code).not.toBe("");
  return { code, verifier };
}

describe("issuing", () => {
  it("returns an RFC 9068 JWT signed with the `as` key, bound to client, audience and scope", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 1800, scope: "read:notes" });
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = body.access_token as string;
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", typ: "at+jwt" });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: RESOURCE,
      client_id: CLIENT_ID,
      scope: "read:notes",
    });
    expect(claims.sub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(1800);
    expect(await mcpPing(flow, token)).toBe(200);
  });

  it("records the jti in the registry and in issued_access before returning, keyed by the code's family", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const { body } = await exchange(flow, tokenFields(code, verifier));
    const { jti, exp } = decodeJwt(body.access_token as string);
    const [row] = rows<{ jti: string; family_id: string; expires_at: number }>(
      flow,
      "SELECT * FROM issued_access",
    );
    expect(row?.jti).toBe(jti);
    expect(row?.expires_at).toBe((exp ?? 0) * 1000);
    expect(flow.registry.isRevoked(jti as string)).toBe(false);
    expect(flow.registry.listTokens({}).map((t) => t.jti)).toContain(jti);
  });

  it("returns no token when recording it fails, and the code is still unused", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    vi.spyOn(flow.registry, "recordToken").mockImplementation(() => {
      throw new Error("disk full");
    });
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: "server_error",
      error_description: "the access token could not be issued",
    });
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(0);
    expect(
      rows<{ used_at: number | null }>(flow, "SELECT used_at FROM auth_codes")[0]?.used_at,
    ).toBeNull();
    vi.restoreAllMocks();
    const retry = await exchange(flow, tokenFields(code, verifier));
    expect(retry.res.status).toBe(200);
  });

  it("copies persona and vault from the grant into the token", async () => {
    const flow = await makeFlow({
      personas: { author: { vaults: ["v1"], scopes: ["read:notes", "write:notes"] } },
    });
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(
      flow,
      new Jar(),
      challenge,
      {},
      { persona: "author", vault: "v1" },
    );
    const { body } = await exchange(flow, tokenFields(code, verifier));
    expect(decodeJwt(body.access_token as string)).toMatchObject({
      persona: "author",
      vault: "v1",
    });
  });

  it("keeps a used code's row past its expiry, and drops an unused expired one", async () => {
    const flow = await makeFlow();
    const used = await codeFor(flow);
    await exchange(flow, tokenFields(used.code, used.verifier));
    await codeFor(flow, { state: "s2" });
    const later = flow.clock.t + 10 * 60_000;
    gcOauthDb(flow.db, { now: later, dcrUnusedDays: 90 });
    const left = rows<{ used_at: number | null }>(flow, "SELECT used_at FROM auth_codes");
    expect(left).toHaveLength(1);
    expect(left[0]?.used_at).not.toBeNull();
    gcOauthDb(flow.db, { now: later + 2 * 3_600_000, dcrUnusedDays: 90 });
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(0);
  });
});

describe("PKCE downgrade", () => {
  it("a request without code_verifier is invalid_grant", async () => {
    const flow = await makeFlow();
    const { code } = await codeFor(flow);
    const { res, body } = await exchange(
      flow,
      tokenFields(code, "x", { code_verifier: undefined }),
    );
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
  });

  it("a wrong verifier is invalid_grant, and so is a malformed one", async () => {
    const flow = await makeFlow();
    const { code } = await codeFor(flow);
    for (const bad of [pkce().verifier, "short", `${"a".repeat(43)}!`, "a".repeat(129)]) {
      const { res, body } = await exchange(flow, tokenFields(code, bad));
      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid_grant");
    }
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(0);
  });

  it("the challenge is compared as S256, not plain: sending the challenge itself fails", async () => {
    const flow = await makeFlow();
    const { challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge);
    const { body } = await exchange(flow, tokenFields(code, challenge));
    expect(body.error).toBe("invalid_grant");
  });
});

describe("code injection and replay", () => {
  it("a second exchange is invalid_grant AND the first exchange's access token now fails at /mcp", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const first = await exchange(flow, tokenFields(code, verifier));
    expect(first.res.status).toBe(200);
    const token = first.body.access_token as string;
    expect(await mcpPing(flow, token)).toBe(200);

    const second = await exchange(flow, tokenFields(code, verifier));
    expect(second.res.status).toBe(400);
    expect(second.body.error).toBe("invalid_grant");
    expect(flow.registry.isRevoked(decodeJwt(token).jti as string)).toBe(true);
    expect(await mcpPing(flow, token)).toBe(401);
  });

  it("two exchanges racing for one code: exactly one answers, and the winner's token is revoked too", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const [a, b] = await Promise.all([
      exchange(flow, tokenFields(code, verifier)),
      exchange(flow, tokenFields(code, verifier)),
    ]);
    const statuses = [a.res.status, b.res.status].sort();
    expect(statuses).toEqual([200, 400]);
    const winner = a.res.status === 200 ? a : b;
    expect(await mcpPing(flow, winner.body.access_token as string)).toBe(401);
  });

  it("the replay is noticed after the code has expired too (the used row outlives it)", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const first = await exchange(flow, tokenFields(code, verifier));
    flow.clock.t += 5 * 60_000;
    gcOauthDb(flow.db, { now: flow.clock.t, dcrUnusedDays: 90 });
    const again = await exchange(flow, tokenFields(code, verifier));
    expect(again.body.error).toBe("invalid_grant");
    expect(
      flow.registry.isRevoked(decodeJwt(first.body.access_token as string).jti as string),
    ).toBe(true);
  });

  describe("knowing a used code is not enough to revoke what it issued", () => {
    // Each case replays with ONE binding wrong: it is refused AND the first exchange's token survives.
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ["another client", { client_id: LOOPBACK_CLIENT }],
      ["another redirect_uri", { redirect_uri: "https://app.example/other" }],
      ["another resource", { resource: "https://elsewhere.example/mcp" }],
      ["a verifier that does not hash to the challenge", { code_verifier: pkce().verifier }],
      ["a malformed verifier", { code_verifier: "short" }],
      ["no verifier", { code_verifier: undefined }],
    ];
    for (const [name, over] of cases) {
      it(`a replay with ${name} is refused and revokes nothing`, async () => {
        const flow = await makeFlow();
        const { code, verifier } = await codeFor(flow);
        const first = await exchange(flow, tokenFields(code, verifier));
        const token = first.body.access_token as string;
        expect(await mcpPing(flow, token)).toBe(200);

        const attempt = await exchange(flow, tokenFields(code, verifier, over));
        expect(attempt.res.status).toBe(400);
        expect(flow.registry.isRevoked(decodeJwt(token).jti as string)).toBe(false);
        expect(await mcpPing(flow, token)).toBe(200);

        // The real client replaying with every binding right still revokes the family.
        const real = await exchange(flow, tokenFields(code, verifier));
        expect(real.body.error).toBe("invalid_grant");
        expect(await mcpPing(flow, token)).toBe(401);
      });
    }

    it("a replay naming a confidential client without its secret is refused and revokes nothing", async () => {
      const flow = await makeFlow();
      const { code, verifier } = await codeFor(flow);
      const token = (await exchange(flow, tokenFields(code, verifier))).body.access_token as string;
      const attempt = await exchange(
        flow,
        tokenFields(code, verifier, { client_id: SECRET_CLIENT }),
      );
      expect(attempt.res.status).toBe(401);
      expect(await mcpPing(flow, token)).toBe(200);
    });
  });

  it("a code lives 60 seconds", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    flow.clock.t += 61_000;
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
  });

  it("a code is bound to its client, its redirect URI and its resource", async () => {
    const flow = await makeFlow();
    const a = await codeFor(flow);
    const otherClient = await exchange(
      flow,
      tokenFields(a.code, a.verifier, { client_id: LOOPBACK_CLIENT }),
    );
    expect(otherClient.body.error).toBe("invalid_grant");
    const otherRedirect = await exchange(
      flow,
      tokenFields(a.code, a.verifier, { redirect_uri: "https://app.example/other" }),
    );
    expect(otherRedirect.body.error).toBe("invalid_grant");
    const noRedirect = await exchange(
      flow,
      tokenFields(a.code, a.verifier, { redirect_uri: undefined }),
    );
    expect(noRedirect.body.error).toBe("invalid_request");
    // None of those burned it.
    const ok = await exchange(flow, tokenFields(a.code, a.verifier));
    expect(ok.res.status).toBe(200);
  });

  it("an unknown code is invalid_grant; a revoked grant refuses its code", async () => {
    const flow = await makeFlow();
    const { verifier } = pkce();
    expect((await exchange(flow, tokenFields("nope", verifier))).body.error).toBe("invalid_grant");
    const g = await codeFor(flow);
    flow.db.prepare("UPDATE grants SET revoked_at = ?").run(flow.clock.t);
    expect((await exchange(flow, tokenFields(g.code, g.verifier))).body.error).toBe(
      "invalid_grant",
    );
  });
});

describe("audience confusion", () => {
  it("a token request with another resource is invalid_target", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const { res, body } = await exchange(
      flow,
      tokenFields(code, verifier, { resource: "https://other.example/mcp" }),
    );
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_target");
  });

  it("an omitted resource uses the code's; the issued aud is always the configured resource", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const { res, body } = await exchange(
      flow,
      tokenFields(code, verifier, { resource: undefined }),
    );
    expect(res.status).toBe(200);
    expect(decodeJwt(body.access_token as string).aud).toBe(RESOURCE);
  });
});

describe("client authentication and request shape", () => {
  it("a public client sends client_id only; presenting credentials is invalid_client", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const basic = `Basic ${Buffer.from(`${CLIENT_ID}:x`).toString("base64")}`;
    const r = await exchange(flow, tokenFields(code, verifier), { authorization: basic });
    expect(r.res.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
    const none = await exchange(flow, tokenFields(code, verifier, { client_id: undefined }));
    expect(none.res.status).toBe(401);
    expect(none.body.error).toBe("invalid_client");
    const unknown = await exchange(flow, tokenFields(code, verifier, { client_id: "nobody" }));
    expect(unknown.body.error).toBe("invalid_client");
  });

  it("a confidential client authenticates with client_secret_basic", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, {
      client_id: SECRET_CLIENT,
      redirect_uri: "https://secret.example/cb",
    });
    const fields = tokenFields(code, verifier, {
      client_id: undefined,
      redirect_uri: "https://secret.example/cb",
    });
    const auth = (s: string) => ({
      authorization: `Basic ${Buffer.from(`${SECRET_CLIENT}:${s}`).toString("base64")}`,
    });
    expect((await exchange(flow, fields)).body.error).toBe("invalid_client");
    expect((await exchange(flow, fields, auth("wrong"))).body.error).toBe("invalid_client");
    expect(
      (await exchange(flow, { ...fields, client_secret: SECRET_CLIENT_SECRET })).body.error,
    ).toBe("invalid_client");
    const ok = await exchange(flow, fields, auth(SECRET_CLIENT_SECRET));
    expect(ok.res.status).toBe(200);
    expect(decodeJwt(ok.body.access_token as string).client_id).toBe(SECRET_CLIENT);
  });

  it("only authorization_code and refresh_token, and only urlencoded bodies", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow);
    const refresh = await exchange(flow, {
      grant_type: "refresh_token",
      refresh_token: "x",
      client_id: CLIENT_ID,
    });
    expect(refresh.body.error).toBe("invalid_grant");
    const cc = await exchange(flow, { grant_type: "client_credentials", client_id: CLIENT_ID });
    expect(cc.body.error).toBe("unsupported_grant_type");
    const missing = await exchange(flow, tokenFields(code, verifier, { grant_type: undefined }));
    expect(missing.body.error).toBe("invalid_request");
    const json = await flow.app.request(flow.url("/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenFields(code, verifier)),
    });
    expect(json.status).toBe(415);
    const repeated = await flow.app.request(flow.url("/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${new URLSearchParams(tokenFields(code, verifier as string) as Record<string, string>)}&code=other`,
    });
    expect(repeated.status).toBe(400);
  });

  it("is refused while unclaimed, and a GET is not a token endpoint", async () => {
    const flow = await makeFlow({ claim: false });
    const r = await exchange(flow, tokenFields("c", "v".repeat(43)));
    expect(r.res.status).toBe(503);
    const claimed = await makeFlow();
    expect((await claimed.app.request(claimed.url("/oauth/token"))).status).toBe(404);
  });
});
