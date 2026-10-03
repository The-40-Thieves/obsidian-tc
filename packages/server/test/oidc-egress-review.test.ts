// Release review follow-ups for auth.mode "oidc":
//  - isBlockedAddress missed 6to4 (2002::/16) and Teredo (2001:0::/32) wrapping a blocked IPv4;
//  - allowedJwksHosts matched the hostname and ignored the port the discovered jwks_uri names;
//  - a jwks_uri carrying query credentials was printed verbatim in errors, the startup line and
//    the doctor output.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOidcVerifier, oidcBootNotice } from "../src/auth/oidc";
import { boundedJwksFetch, discoverOidc, fetchBoundedText } from "../src/auth/oidc-discovery";
import { isBlockedAddress } from "../src/auth/oidc-network";
import { authOidcCheck } from "../src/doctor/auth-oidc";
import { AUDIENCE, ISSUER, type MockIdp, publicResolver, startMockIdp } from "./oidc-mock-provider";

describe("isBlockedAddress: tunnel prefixes that embed a blocked IPv4", () => {
  it.each([
    ["2002:a9fe:a9fe::", "6to4 of 169.254.169.254 (the reviewer's repro)"],
    ["2002:7f00:1::1", "6to4 of 127.0.0.1"],
    ["2002:0a00:0001::", "6to4 of 10.0.0.1"],
    ["2002:c0a8:101::", "6to4 of 192.168.1.1"],
    ["[2002:a9fe:a9fe::1]", "bracketed"],
    ["2001:0:a9fe:a9fe:0:0:80ff:fffe", "Teredo: server 169.254.169.254, client 127.0.0.1"],
    ["2001:0:5db8:d822:0:0:5601:5601", "Teredo: public server, client 169.254.169.254"],
    ["2001:0:a9fe:a9fe:0:0:a29b:27dd", "Teredo: blocked server, public client"],
  ])("blocks %s (%s)", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it("still allows a 6to4 or Teredo address whose embedded IPv4 are all public, and ordinary public IPv6", () => {
    expect(isBlockedAddress("2002:5db8:d822::")).toBe(false); // 6to4 of 93.184.216.34
    expect(isBlockedAddress("2001:0:5db8:d822:0:0:a29b:27dd")).toBe(false); // public server and client
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });
});

describe("allowedJwksHosts is port-aware", () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await startMockIdp();
  });
  afterEach(() => idp.close());
  const build = (oidc: Record<string, unknown>) =>
    createOidcVerifier(
      ServerConfigSchema.parse({
        vaults: [{ id: "v1", path: "/tmp/v1" }],
        auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE, ...oidc } },
      }).auth,
      { fetch: idp.fetch, jwksCooldownMs: 0, resolveHost: publicResolver },
    );

  it("refuses a listed host on a non-default port (the reviewer's repro)", async () => {
    idp.setDiscovery({ jwks_uri: "https://cdn.other.test:8443/jwks" });
    await expect(build({ allowedJwksHosts: ["cdn.other.test"] })).rejects.toThrow(
      /jwks_uri.*8443|8443.*jwks_uri/i,
    );
  });

  it("accepts a listed host on the default https port, spelled with or without :443", async () => {
    idp.setDiscovery({ jwks_uri: "https://cdn.other.test/jwks" });
    expect((await build({ allowedJwksHosts: ["cdn.other.test"] })).describe().jwksUri).toBe(
      "https://cdn.other.test/jwks",
    );
    idp.setDiscovery({ jwks_uri: "https://cdn.other.test:443/jwks" });
    await build({ allowedJwksHosts: ["cdn.other.test"] });
  });
});

describe("a jwks_uri carrying query credentials is never printed", () => {
  const SECRET = "TOPSECRET";
  const URL_WITH_SECRET = `https://idp.example/jwks?token=${SECRET}`;
  const okNet = { resolveHost: async () => ["93.184.216.34"] };

  it("fetchBoundedText: HTTP 503 error names the host and path, not the query", async () => {
    const err = await fetchBoundedText(URL_WITH_SECRET, {
      fetch: async () => new Response("nope", { status: 503 }),
      maxBytes: 1024,
      what: "OIDC JWKS",
      network: okNet,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/idp\.example\/jwks/);
    expect((err as Error).message).toMatch(/503/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it.each([
    ["a redirect", async () => new Response(null, { status: 302, headers: { location: "/x" } })],
    ["a network error", async () => Promise.reject(new Error(`connect failed ${URL_WITH_SECRET}`))],
    ["an oversized declared body", async () => new Response("x", { headers: { "content-length": "999999" } })],
  ])("fetchBoundedText: %s leaks no secret", async (_name, fetchImpl) => {
    const err = await fetchBoundedText(URL_WITH_SECRET, {
      fetch: fetchImpl as typeof fetch,
      maxBytes: 1024,
      what: "OIDC JWKS",
      network: okNet,
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("fetchBoundedText: a non-https URL's refusal does not echo the query", async () => {
    const err = await fetchBoundedText(`http://idp.example/jwks?token=${SECRET}`, {
      maxBytes: 1024,
      what: "OIDC JWKS",
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/https/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("boundedJwksFetch (jose's fetch) fails without the secret", async () => {
    const f = boundedJwksFetch({
      fetch: async () => new Response("nope", { status: 503 }),
      network: okNet,
    });
    const err = await f(URL_WITH_SECRET, {
      signal: undefined as unknown as AbortSignal,
      headers: new Headers(),
      redirect: "manual",
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/503/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("discoverOidc: an unusable jwks_uri error does not echo the secret", async () => {
    const issuer = "https://idp.example";
    const doc = JSON.stringify({ issuer, jwks_uri: `https://other.example/jwks?token=${SECRET}` });
    const err = await discoverOidc(issuer, {
      fetch: async () => new Response(doc, { status: 200 }),
      ...okNet,
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/jwks_uri/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("the startup line prints the jwks_uri without its query", () => {
    const line = oidcBootNotice({
      issuer: "https://idp.example",
      jwksUri: URL_WITH_SECRET,
      audience: "aud",
      allowedAlgs: ["RS256"],
    });
    expect(line).toMatch(/jwks_uri=https:\/\/idp\.example\/jwks/);
    expect(line).not.toContain(SECRET);
    expect(line).toMatch(/issuer=https:\/\/idp\.example/);
  });

  it("doctor: the probed jwks_uri is shown without its query, in the summary and the details", async () => {
    const r = await authOidcCheck({
      authMode: "oidc",
      issuer: "https://idp.example",
      audience: "aud",
      allowedAlgs: ["RS256"],
      clockToleranceSeconds: 30,
      prmConfigured: true,
      requireJti: true,
      probe: async () => ({ ok: true, jwksUri: URL_WITH_SECRET, keyCount: 1 }),
    }).run({ serverVersion: "t" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).toContain("https://idp.example/jwks");
  });

  it("doctor: a probe failure message carrying the URL is scrubbed", async () => {
    const r = await authOidcCheck({
      authMode: "oidc",
      issuer: "https://idp.example",
      audience: "aud",
      allowedAlgs: ["RS256"],
      clockToleranceSeconds: 30,
      prmConfigured: true,
      requireJti: true,
      probe: async () => ({ ok: false, error: `could not fetch ${URL_WITH_SECRET}: HTTP 503` }),
    }).run({ serverVersion: "t" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
