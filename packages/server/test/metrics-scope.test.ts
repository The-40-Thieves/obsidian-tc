// The remotely bound /metrics endpoint is an OPERATOR surface: a verified bearer is not enough, it
// must hold `admin:metrics` (the scope the `get_metrics` tool already requires), and a token bound
// to a vault (or a persona, which always resolves to one) is refused because every gauge and
// counter here is process-wide. Incident shape reproduced by review: a verified JWT with `scopes: []`
// bound to `public-vault` got 200 including `obsidian_tc_capture_queue_depth{vault="secret-vault"} 7`.
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createMetricsApp } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const now = () => Math.floor(Date.now() / 1000);
const base = { tokenTtlSeconds: 86400, rotationGraceSeconds: 0, requireJti: false } as const;

const sign = (extra: Record<string, unknown>) =>
  new SignJWT({ sub: "scraper", iat: now(), exp: now() + 600, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(SECRET));

function recorder(): MetricsRecorder {
  return new MetricsRecorder({
    captureQueueDepth: () => [
      { vault: "secret-vault", value: 7 },
      { vault: "public-vault", value: 1 },
    ],
  });
}

function remote(bind = "0.0.0.0") {
  return createMetricsApp({
    recorder: recorder(),
    bind,
    port: 0,
    auth: { mode: "jwt", jwtSecret: SECRET, ...base },
  });
}

const get = (app: ReturnType<typeof remote>, token?: string) =>
  app.request("/metrics", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("remote /metrics requires admin:metrics", () => {
  it("401 with no token", async () => {
    expect((await get(remote())).status).toBe(401);
  });

  it("403 insufficient_scope for a verified token with zero scopes", async () => {
    const res = await get(remote(), await sign({ scopes: [] }));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(res.headers.get("www-authenticate")).toContain('scope="admin:metrics"');
    expect(await res.text()).not.toContain("obsidian_tc_");
  });

  it("403 for scopes that are not admin:metrics (read wildcard, another admin scope)", async () => {
    for (const scopes of [["read:*"], ["read:notes"], ["admin:vault"], ["write:*"]]) {
      expect((await get(remote(), await sign({ scopes }))).status, scopes.join()).toBe(403);
    }
  });

  it("200 with admin:metrics, and via the wildcard rules (*, admin:*, admin)", async () => {
    for (const scopes of [["admin:metrics"], ["*"], ["admin:*"], ["admin"]]) {
      const res = await get(remote(), await sign({ scopes }));
      expect(res.status, scopes.join()).toBe(200);
      expect(await res.text()).toContain("# TYPE obsidian_tc_capture_queue_depth gauge");
    }
  });

  it("reads the space-delimited `scope` claim like every other verify path", async () => {
    expect((await get(remote(), await sign({ scope: "admin:metrics" }))).status).toBe(200);
  });
});

describe("remote /metrics refuses vault-bound and persona tokens", () => {
  it("the reviewed repro: scopes [] bound to public-vault never sees secret-vault", async () => {
    const res = await get(remote(), await sign({ scopes: [], vault: "public-vault" }));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("secret-vault");
    expect(body).not.toContain("capture_queue_depth");
  });

  it("403 even when the bound token holds admin:metrics (series are process-wide)", async () => {
    for (const scopes of [["admin:metrics"], ["*"]]) {
      const res = await get(remote(), await sign({ scopes, vault: "public-vault" }));
      expect(res.status, scopes.join()).toBe(403);
      expect(await res.text()).not.toContain("secret-vault");
    }
  });

  it("403 for a persona token (a persona always resolves to a vault), configured or not", async () => {
    const res = await get(remote(), await sign({ scopes: ["*"], persona: "reader" }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("secret-vault");
  });

  it("a token that fails verification stays 401, never 403", async () => {
    expect((await get(remote(), "junk")).status).toBe(401);
  });
});

describe("loopback behaviour is unchanged", () => {
  it("serves every vault's series with no token, on every loopback spelling", async () => {
    for (const bind of ["127.0.0.1", "::1", "localhost"]) {
      const res = await get(remote(bind));
      expect(res.status, bind).toBe(200);
      expect(await res.text()).toContain('obsidian_tc_capture_queue_depth{vault="secret-vault"} 7');
    }
  });

  it("does not demand the scope on loopback even when auth.mode is jwt", async () => {
    // A bearer, if sent, is not inspected on loopback (documented: loopback -> open).
    expect((await get(remote("127.0.0.1"), await sign({ scopes: [] }))).status).toBe(200);
  });

  it("an unbound scoped token sees every vault on a remote bind (operator view)", async () => {
    const res = await get(remote(), await sign({ scopes: ["admin:metrics"] }));
    const body = await res.text();
    expect(body).toContain('vault="secret-vault"');
    expect(body).toContain('vault="public-vault"');
  });
});
