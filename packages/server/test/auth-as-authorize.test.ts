// `GET /oauth/authorize` (slice S5; design v2 sections 4.3 and 8). Every row here is a threat-model
// row with a RED test: open redirect, PKCE downgrade, audience confusion, mix-up.
import { afterEach, describe, expect, it } from "vitest";
import {
  authorize,
  CLIENT_ID,
  CLIENT_REDIRECT,
  cleanupFlows,
  ISSUER,
  Jar,
  LOOPBACK_CLIENT,
  makeFlow,
  pkce,
  RESOURCE,
  rows,
} from "./as-flow-harness";

afterEach(cleanupFlows);

const { challenge } = pkce();

describe("open redirect: the redirect URI is validated before anything can redirect", () => {
  it("an unregistered redirect_uri is a 400 HTML page with NO Location", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, {
      redirect_uri: "https://evil.example/cb",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(0);
  });

  it("an unknown client is a 400 HTML page with NO Location (even with a registered-looking redirect)", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, { client_id: "nobody" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("an https client-ID URL is not looked up as a static client (no metadata documents yet)", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, {
      client_id: "https://app.example/client.json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a missing or repeated redirect_uri is a local error, never a redirect", async () => {
    const flow = await makeFlow();
    const missing = await authorize(flow, new Jar(), challenge, { redirect_uri: undefined });
    expect(missing.status).toBe(400);
    expect(missing.headers.get("location")).toBeNull();
    const url = `/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code`;
    const repeated = await flow.app.request(flow.url(url), { redirect: "manual" });
    expect(repeated.status).toBe(400);
    expect(repeated.headers.get("location")).toBeNull();
  });

  it("a non-loopback redirect must match exactly (path, port, scheme, trailing slash)", async () => {
    const flow = await makeFlow();
    for (const uri of [
      "https://app.example/cb/",
      "https://app.example/cb?x=1",
      "https://app.example:8443/cb",
      "http://app.example/cb",
      "https://APP.example.evil/cb",
      "https://app.example/cb#frag",
    ]) {
      const res = await authorize(flow, new Jar(), challenge, { redirect_uri: uri });
      expect(res.status, uri).toBe(400);
      expect(res.headers.get("location"), uri).toBeNull();
    }
  });

  it("loopback matches with the port ignored: localhost:9999 matches http://localhost/cb", async () => {
    const flow = await makeFlow();
    const ok = await authorize(flow, new Jar(), challenge, {
      client_id: LOOPBACK_CLIENT,
      redirect_uri: "http://localhost:9999/cb",
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toMatch(/^\/oauth\/login\?request=/);
    const v4 = await authorize(flow, new Jar(), challenge, {
      client_id: LOOPBACK_CLIENT,
      redirect_uri: "http://127.0.0.1:53211/callback",
    });
    expect(v4.status).toBe(303);
  });

  it("http://localhost.evil.example/cb does not match, nor does any other lookalike host", async () => {
    const flow = await makeFlow();
    for (const uri of [
      "http://localhost.evil.example/cb",
      "http://localhost@evil.example/cb",
      "http://localhost:9999@evil.example/cb",
      "http://localhost:9999/other",
      "http://localhost:9999/cb?x=1",
      "https://localhost:9999/cb",
      "http://127.0.0.1:9999/cb",
      "http://[::1]:9999/callback",
    ]) {
      const res = await authorize(flow, new Jar(), challenge, {
        client_id: LOOPBACK_CLIENT,
        redirect_uri: uri,
      });
      expect(res.status, uri).toBe(400);
      expect(res.headers.get("location"), uri).toBeNull();
    }
  });
});

const errorOf = (res: Response) => {
  const loc = new URL(res.headers.get("location") ?? "https://x.invalid/");
  return {
    status: res.status,
    origin: loc.origin + loc.pathname,
    error: loc.searchParams.get("error"),
    iss: loc.searchParams.get("iss"),
    state: loc.searchParams.get("state"),
  };
};

describe("PKCE downgrade: S256 is required on every request", () => {
  it("code_challenge_method=plain -> invalid_request", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, { code_challenge_method: "plain" });
    expect(errorOf(res)).toMatchObject({
      status: 303,
      error: "invalid_request",
      origin: CLIENT_REDIRECT,
    });
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(0);
  });

  it("an absent method, an absent challenge and a malformed challenge are refused", async () => {
    const flow = await makeFlow();
    for (const over of [
      { code_challenge_method: undefined },
      { code_challenge: undefined },
      { code_challenge: "short" },
    ]) {
      const res = await authorize(flow, new Jar(), challenge, over);
      expect(errorOf(res).error, JSON.stringify(over)).toBe("invalid_request");
    }
  });
});

describe("audience confusion: resource must be this server's resource", () => {
  it("resource=https://other.example/mcp -> invalid_target", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, {
      resource: "https://other.example/mcp",
    });
    expect(errorOf(res)).toMatchObject({ error: "invalid_target", origin: CLIENT_REDIRECT });
  });

  it("an absent resource is invalid_target too", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, { resource: undefined });
    expect(errorOf(res).error).toBe("invalid_target");
  });

  it("scheme and host are compared case-insensitively, the path exactly", async () => {
    const flow = await makeFlow();
    const ok = await authorize(flow, new Jar(), challenge, {
      resource: "HTTPS://Vault.Example.COM/mcp",
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toMatch(/^\/oauth\/login/);
    const wrongPath = await authorize(flow, new Jar(), challenge, { resource: `${RESOURCE}/` });
    expect(errorOf(wrongPath).error).toBe("invalid_target");
    // The stored resource is the configured one, whatever spelling the client used.
    expect(
      rows<{ resource: string }>(flow, "SELECT resource FROM auth_requests")[0]?.resource,
    ).toBe(RESOURCE);
  });
});

describe("mix-up: iss on every authorization response, errors included", () => {
  it("each error redirect carries iss=<issuer> byte for byte, and the client's state", async () => {
    const flow = await makeFlow();
    const cases: Array<Record<string, string | undefined>> = [
      { code_challenge_method: "plain" },
      { resource: "https://other.example/mcp" },
      { response_type: "token" },
      { scope: "bogus:thing" },
    ];
    for (const over of cases) {
      const res = await authorize(flow, new Jar(), challenge, over);
      const e = errorOf(res);
      expect(e.status, JSON.stringify(over)).toBe(303);
      expect(e.iss, JSON.stringify(over)).toBe(ISSUER);
      expect(e.state, JSON.stringify(over)).toBe("st-123");
      expect(e.error, JSON.stringify(over)).toBeTruthy();
    }
  });

  it("response_type other than code -> unsupported_response_type", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge, { response_type: "token" });
    expect(errorOf(res).error).toBe("unsupported_response_type");
  });

  it("an iss already in the redirect URI's query cannot override the real one", async () => {
    const flow = await makeFlow({
      as: {
        clients: [
          {
            clientId: "q",
            name: "Q",
            redirectUris: ["https://q.example/cb?iss=https://evil.example"],
          },
        ],
      },
    });
    const res = await authorize(flow, new Jar(), challenge, {
      client_id: "q",
      redirect_uri: "https://q.example/cb?iss=https://evil.example",
      response_type: "token",
    });
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.getAll("iss")).toEqual([ISSUER]);
  });
});

describe("scopes and the pending request", () => {
  it("unknown scopes are dropped; only unknown ones is invalid_scope", async () => {
    const flow = await makeFlow();
    const mixed = await authorize(flow, new Jar(), challenge, {
      scope: "read:notes bogus offline_access",
    });
    expect(mixed.status).toBe(303);
    expect(rows<{ scope: string }>(flow, "SELECT scope FROM auth_requests")[0]?.scope).toBe(
      "read:notes",
    );
    const none = await authorize(flow, new Jar(), challenge, { scope: "bogus" });
    expect(errorOf(none).error).toBe("invalid_scope");
  });

  it("no scope asks for the default; scopesSupported bounds the vocabulary", async () => {
    const flow = await makeFlow({ scopesSupported: ["read:notes", "write:notes"] });
    await authorize(flow, new Jar(), challenge, { scope: undefined });
    await authorize(flow, new Jar(), challenge, { scope: "read:notes admin:auth" });
    const scopes = rows<{ scope: string }>(
      flow,
      "SELECT scope FROM auth_requests ORDER BY created_at, rowid",
    ).map((r) => r.scope);
    expect(scopes).toEqual(["read:notes write:notes", "read:notes"]);
  });

  it("stores only the handle's hash, for 10 minutes, and redirects to login without a session", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge);
    const handle =
      new URL(res.headers.get("location") ?? "", ISSUER).searchParams.get("request") ?? "";
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = rows<{
      handle_hash: string;
      created_at: number;
      expires_at: number;
      state: string;
    }>(flow, "SELECT * FROM auth_requests");
    expect(row?.handle_hash).not.toBe(handle);
    expect(row?.expires_at).toBe((row?.created_at ?? 0) + 10 * 60_000);
    expect(row?.state).toBe("st-123");
  });

  it("answers 503 when too many requests are waiting", async () => {
    const flow = await makeFlow();
    const ins = flow.db.prepare(
      "INSERT INTO auth_requests (handle_hash, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at) VALUES (?, 'c', 'r', 's', 'x', 'y', ?, ?)",
    );
    const now = flow.clock.t;
    for (let i = 0; i < 1000; i++) ins.run(`h${i}`, now, now + 600_000);
    const res = await authorize(flow, new Jar(), challenge);
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("is refused while the server is unclaimed", async () => {
    const flow = await makeFlow({ claim: false });
    const res = await authorize(flow, new Jar(), challenge);
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("carries the AS headers on the redirect itself", async () => {
    const flow = await makeFlow();
    const res = await authorize(flow, new Jar(), challenge);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
