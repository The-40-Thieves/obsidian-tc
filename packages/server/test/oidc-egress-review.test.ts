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

  it("fetchBoundedText: HTTP 503 error names the host, not the path or query", async () => {
    const err = await fetchBoundedText(URL_WITH_SECRET, {
      fetch: async () => new Response("nope", { status: 503 }),
      maxBytes: 1024,
      what: "OIDC JWKS",
      network: okNet,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/https:\/\/idp\.example(?!\/jwks)/);
    expect((err as Error).message).toMatch(/503/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it.each([
    ["a redirect", async () => new Response(null, { status: 302, headers: { location: "/x" } })],
    ["a network error", async () => Promise.reject(new Error(`connect failed ${URL_WITH_SECRET}`))],
    [
      "an oversized declared body",
      async () => new Response("x", { headers: { "content-length": "999999" } }),
    ],
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
      method: "GET",
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

  it("the startup line prints the jwks_uri as its origin only", () => {
    const line = oidcBootNotice({
      issuer: "https://idp.example",
      jwksUri: URL_WITH_SECRET,
      audience: "aud",
      allowedAlgs: ["RS256"],
    });
    expect(line).toMatch(/jwks_uri=https:\/\/idp\.example /);
    expect(line).not.toContain(SECRET);
    expect(line).toMatch(/issuer=https:\/\/idp\.example/);
  });

  it("doctor: the probed jwks_uri is shown as its origin only, in the summary and the details", async () => {
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
    expect(JSON.stringify(r)).toContain("https://idp.example");
    expect(JSON.stringify(r)).not.toContain("/jwks");
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

// A key-set URL's PATH can be the credential too (`/jwks/<token>`). The first fix dropped only the
// query and userinfo; the startup line, the doctor output and the fetch errors still printed the path.
describe("a jwks_uri carrying a credential in its PATH is never printed", () => {
  const SECRET = "TOPSECRET";
  const PATH_URL = `https://idp.example/jwks/${SECRET}`;
  const okNet = { resolveHost: async () => ["93.184.216.34"] };
  const chainText = (e: unknown): string => {
    const parts: string[] = [];
    for (let cur: unknown = e, i = 0; cur !== undefined && i < 10; i++) {
      parts.push(cur instanceof Error ? `${cur.name} ${cur.message}` : String(cur));
      cur = cur instanceof Error ? cur.cause : undefined;
    }
    return parts.join("\n");
  };

  it("the startup line", () => {
    const line = oidcBootNotice({
      issuer: "https://idp.example",
      jwksUri: PATH_URL,
      audience: "aud",
      allowedAlgs: ["RS256"],
    });
    expect(line).not.toContain(SECRET);
    expect(line).toContain("jwks_uri=https://idp.example ");
  });

  it("doctor output", async () => {
    const r = await authOidcCheck({
      authMode: "oidc",
      issuer: "https://idp.example",
      audience: "aud",
      allowedAlgs: ["RS256"],
      clockToleranceSeconds: 30,
      prmConfigured: true,
      requireJti: true,
      probe: async () => ({ ok: true, jwksUri: PATH_URL, keyCount: 1 }),
    }).run({ serverVersion: "t" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it.each([
    ["HTTP 503", async () => new Response("nope", { status: 503 })],
    [
      "a network error naming the URL",
      async () => Promise.reject(new Error(`connect ${PATH_URL}`)),
    ],
    ["a redirect", async () => new Response(null, { status: 302, headers: { location: "/x" } })],
  ])(
    "fetchBoundedText on %s: neither the message nor the cause chain has the path",
    async (_n, f) => {
      const err = await fetchBoundedText(PATH_URL, {
        fetch: f as typeof fetch,
        maxBytes: 1024,
        what: "OIDC JWKS",
        network: okNet,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(chainText(err)).not.toContain(SECRET);
    },
  );

  it("a stream that fails mid-read names no path in the message or the cause chain", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`reset while reading ${PATH_URL}`);
      },
    });
    const err = await fetchBoundedText(PATH_URL, {
      fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
      maxBytes: 1024,
      what: "OIDC JWKS",
      network: okNet,
    }).catch((e: unknown) => e);
    expect(chainText(err)).not.toContain(SECRET);
  });

  it("a malformed URL is not echoed", async () => {
    const err = await fetchBoundedText(`https://idp.example:bad/jwks/${SECRET}`, {
      maxBytes: 1024,
      what: "OIDC JWKS",
    }).catch((e: unknown) => e);
    expect(chainText(err)).not.toContain(SECRET);
  });

  it("a URL carrying userinfo is refused without echoing its path", async () => {
    const err = await fetchBoundedText(`https://user:pass@idp.example/jwks/${SECRET}`, {
      maxBytes: 1024,
      what: "OIDC JWKS",
    }).catch((e: unknown) => e);
    expect(chainText(err)).toContain("must not carry credentials");
    expect(chainText(err)).not.toContain(SECRET);
  });

  it("the discovery document URL (issuer-derived, public) keeps its path", async () => {
    const issuer = "https://idp.example/realms/main";
    const err = await discoverOidc(issuer, {
      fetch: async () => new Response("nope", { status: 503 }),
      ...okNet,
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain("https://idp.example/realms/main/.well-known/");
  });

  it("an idp_unavailable rejection's cause chain (a JWKS transport error naming the URL) is clean", async () => {
    const idp = await startMockIdp();
    try {
      const jwksUri = `${ISSUER}/jwks/${SECRET}`;
      const v = await createOidcVerifier(
        ServerConfigSchema.parse({
          vaults: [{ id: "v1", path: "/tmp/v1" }],
          auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUri } },
        }).auth,
        {
          fetch: ((u: string, init?: RequestInit) =>
            String(u).includes(SECRET)
              ? Promise.reject(new Error(`connect ECONNRESET ${u}`))
              : idp.fetch(u, init)) as typeof fetch,
          jwksCooldownMs: 0,
          resolveHost: publicResolver,
        },
      );
      const err = await v.verify(await idp.sign()).catch((e: unknown) => e);
      expect((err as { reason?: string }).reason).toBe("idp_unavailable");
      expect(chainText(err)).not.toContain(SECRET);
    } finally {
      await idp.close();
    }
  });
});
