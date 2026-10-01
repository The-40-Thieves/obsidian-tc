// /metrics under auth.mode jwt|oidc is authenticated on EVERY bind, loopback included: the bind
// address cannot tell a local scraper from a caller a tunnel or reverse proxy forwarded to
// 127.0.0.1. Reproduced by review: with `prometheus.bind: 127.0.0.1` and `auth.mode: jwt`,
//   GET /metrics  Host: attacker.example:9464  X-Forwarded-For: 203.0.113.8   (no Authorization)
// answered 200 with every vault's series. Auth mode `none` keeps the open loopback scrape, behind
// the same Host guard the MCP route has (a browser DNS-rebinding drive-by names its own Host).
// Second reproduced defect: the endpoint built its own verifier without auth.jwks, so a valid
// JWKS-signed token that the MCP edge accepts was 401 here.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { createMetricsApp } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const now = () => Math.floor(Date.now() / 1000);
const base = { tokenTtlSeconds: 86400, rotationGraceSeconds: 0, requireJti: false } as const;
type Auth = Parameters<typeof createMetricsApp>[0]["auth"];

const jwtAuth: Auth = { mode: "jwt", jwtSecret: SECRET, ...base };
const noneAuth: Auth = { mode: "none", ...base };

const sign = (extra: Record<string, unknown>) =>
  new SignJWT({ sub: "scraper", iat: now(), exp: now() + 600, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(SECRET));

function app(
  auth: Auth,
  bind = "127.0.0.1",
  extra: Partial<Parameters<typeof createMetricsApp>[0]> = {},
) {
  return createMetricsApp({
    recorder: new MetricsRecorder({
      captureQueueDepth: () => [{ vault: "secret-vault", value: 7 }],
    }),
    bind,
    port: 0,
    auth,
    verifier: buildJwtVerifier(auth) ?? undefined,
    ...extra,
  });
}

const get = (a: ReturnType<typeof app>, headers: Record<string, string> = {}) =>
  a.request("http://localhost/metrics", { headers });

describe("loopback bind + auth.mode jwt: a token is required", () => {
  it("401 with no token, even with a forwarded-client header pair (the reviewed repro)", async () => {
    const res = await get(app(jwtAuth), {
      host: "localhost:9464",
      "x-forwarded-for": "203.0.113.8",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("secret-vault");
  });

  it("403 for a verified token without admin:metrics, 403 for a vault-bound one", async () => {
    const token = await sign({ scopes: [] });
    expect((await get(app(jwtAuth), { authorization: `Bearer ${token}` })).status).toBe(403);
    const bound = await sign({ scopes: ["admin:metrics"], vault: "public-vault" });
    expect((await get(app(jwtAuth), { authorization: `Bearer ${bound}` })).status).toBe(403);
  });

  it("200 for an unbound admin:metrics token, on every loopback spelling", async () => {
    const token = await sign({ scopes: ["admin:metrics"] });
    for (const bind of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "::ffff:127.0.0.1"]) {
      const res = await get(app(jwtAuth, bind), { authorization: `Bearer ${token}` });
      expect(res.status, bind).toBe(200);
      expect(await res.text()).toContain("secret-vault");
    }
  });
});

describe("loopback bind + auth.mode none: unchanged open scrape", () => {
  it("serves with no token on every spelling the canonical matcher calls loopback", async () => {
    for (const bind of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "::ffff:127.0.0.1"]) {
      const res = await get(app(noneAuth, bind));
      expect(res.status, bind).toBe(200);
      expect(await res.text()).toContain("secret-vault");
    }
  });
});

describe("Host-header guard (the MCP route's DNS-rebinding guard)", () => {
  it("rejects a spoofed Host on a loopback bind, in jwt mode even with a valid token", async () => {
    const token = await sign({ scopes: ["admin:metrics"] });
    const res = await get(app(jwtAuth), {
      host: "attacker.example:9464",
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("secret-vault");
  });

  it("rejects a spoofed Host under auth none (browser DNS rebinding)", async () => {
    expect((await get(app(noneAuth), { host: "attacker.example:9464" })).status).toBe(403);
  });

  it("accepts loopback Host spellings, the bind host, and operator-allowed hosts", async () => {
    for (const host of ["localhost:9464", "127.0.0.1:9464", "[::1]:9464"]) {
      expect((await get(app(noneAuth), { host })).status, host).toBe(200);
    }
    const allowed = app(noneAuth, "127.0.0.1", { allowedHosts: ["metrics.example.com"] });
    expect((await get(allowed, { host: "metrics.example.com" })).status).toBe(200);
    expect((await get(allowed, { host: "other.example.com" })).status).toBe(403);
  });

  it("enableDnsRebindingProtection: false turns the Host guard off, like the MCP route", async () => {
    const off = app(noneAuth, "127.0.0.1", { enableDnsRebindingProtection: false });
    expect((await get(off, { host: "attacker.example:9464" })).status).toBe(200);
  });
});

describe("one verifier: a JWKS-signed token the MCP edge accepts is accepted here", () => {
  it("200 for an unbound admin:metrics RS256 token under an inline JWKS with a matching audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = {
      keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }],
    };
    const auth: Auth = { mode: "jwt", jwks, audience: "https://obsidian-tc.example", ...base };
    const token = await new SignJWT({
      sub: "scraper",
      scopes: ["admin:metrics"],
      aud: "https://obsidian-tc.example",
      iat: now(),
      exp: now() + 600,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .sign(privateKey);
    for (const bind of ["0.0.0.0", "127.0.0.1"]) {
      expect((await get(app(auth, bind), { authorization: `Bearer ${token}` })).status, bind).toBe(
        200,
      );
    }
    // wrong audience stays refused
    const wrong = await new SignJWT({ sub: "s", scopes: ["admin:metrics"], aud: "https://other" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
    expect((await get(app(auth, "0.0.0.0"), { authorization: `Bearer ${wrong}` })).status).toBe(
      401,
    );
  });
});
