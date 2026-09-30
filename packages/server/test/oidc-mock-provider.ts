// A local mock OIDC provider for the `oidc` auth-mode tests: serves the discovery document and the
// JWKS over plain HTTP on loopback, and hands the code under test a `fetch` that maps the public
// https issuer onto it. Production code is https-only (checked in the tests), so the tests cannot
// point at http://127.0.0.1 directly; the mapped fetch is the seam, the wire is a real socket.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

export const ISSUER = "https://idp.test";
export const AUDIENCE = "https://vault.example.com/mcp";

type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface MockIdp {
  issuer: string;
  /** Loopback base the https issuer is mapped to. */
  base: string;
  /** Drop-in `fetch` for the code under test: rewrites `${issuer}` to the loopback base. */
  fetch: typeof fetch;
  hits: { discovery: number; jwks: number };
  /** Replace the discovery document (merged over the default one). */
  setDiscovery(patch: Record<string, unknown> | null): void;
  /** Serve this raw body (instead of the JWKS) with this status, or restore with `null`. */
  setJwksResponse(r: { status?: number; body?: string; hang?: boolean } | null): void;
  setDiscoveryResponse(
    r: { status?: number; body?: string; headers?: Record<string, string>; hang?: boolean } | null,
  ): void;
  /** Publish an additional key in the JWKS (rotation). */
  publish(jwk: JWK): void;
  /** The public JWK currently signing (kid `k1`). */
  publicJwk: JWK;
  privateKey: SignKey;
  /** Mint an IdP-shaped access token. Header/claim defaults are a healthy RFC 9068 token. */
  sign(
    claims?: Record<string, unknown>,
    o?: { alg?: string; kid?: string | null; typ?: string | null; key?: SignKey; unset?: string[] },
  ): Promise<string>;
  close(): Promise<void>;
}

export async function startMockIdp(): Promise<MockIdp> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const extra: JWK[] = [];
  let discoveryPatch: Record<string, unknown> | null = null;
  let jwksResp: { status?: number; body?: string; hang?: boolean } | null = null;
  let discoveryResp: {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    hang?: boolean;
  } | null = null;
  const hits = { discovery: 0, jwks: 0 };

  const server: Server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      hits.discovery++;
      if (discoveryResp?.hang) return;
      if (discoveryResp) {
        res.writeHead(discoveryResp.status ?? 200, {
          "content-type": "application/json",
          ...discoveryResp.headers,
        });
        res.end(discoveryResp.body ?? "");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/jwks`,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          ...discoveryPatch,
        }),
      );
      return;
    }
    if (req.url === "/jwks" || req.url === "/custom-jwks") {
      hits.jwks++;
      if (jwksResp?.hang) return;
      if (jwksResp) {
        res.writeHead(jwksResp.status ?? 200, { "content-type": "application/json" });
        res.end(jwksResp.body ?? "");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk, ...extra] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mapped: typeof fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    return fetch(url.startsWith(ISSUER) ? base + url.slice(ISSUER.length) : url, init);
  };

  return {
    issuer: ISSUER,
    base,
    fetch: mapped,
    hits,
    setDiscovery: (p) => {
      discoveryPatch = p;
    },
    setJwksResponse: (r) => {
      jwksResp = r;
    },
    setDiscoveryResponse: (r) => {
      discoveryResp = r;
    },
    publish: (jwk) => {
      extra.push(jwk);
    },
    publicJwk,
    privateKey,
    async sign(claims = {}, o = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "user-1",
        scope: "read:notes",
        iat: now,
        exp: now + 600,
        jti: crypto.randomUUID(),
        ...claims,
      };
      for (const k of o.unset ?? []) delete payload[k];
      const header: Record<string, unknown> = { alg: o.alg ?? "ES256" };
      if (o.kid !== null) header.kid = o.kid ?? "k1";
      if (o.typ !== null) header.typ = o.typ ?? "at+jwt";
      return new SignJWT(payload).setProtectedHeader(header as never).sign(o.key ?? privateKey);
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
