// Boot-time messages for a JWT-mode server whose key source is a JWKS:
//   - the missing-audience deprecation is emitted on EVERY boot, including a stdio-only one (no
//     HTTP, no /metrics) where no bearer verifier is built;
//   - the one startup lookup of `auth.jwksUri` has a 3 s budget, so a timeout or a DNS error there
//     says the key set could not be checked and will be retried per request (the fetch decides
//     again each time), and only a definitive policy refusal says REFUSED.
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { jwksModeLine } from "../src/auth/jwks-network";
import { setProviderResolveHostForTest } from "../src/gateway/provider-fetch";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

vi.mock("../src/transports/http", () => ({
  startHttp: async () => ({ port: 1, close: async () => {} }),
}));
vi.mock("../src/metrics/endpoint", () => ({
  startMetricsEndpoint: async () => ({ port: 2, close: async () => {} }),
}));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});
afterEach(() => {
  vi.restoreAllMocks();
  setProviderResolveHostForTest(undefined);
});

const JWKS = {
  keys: [
    { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", kid: "k1" },
  ],
};

const STDIO_ONLY = { http: false, prometheus: false };

/** Boot with `auth` and the given listeners; returns everything written to stderr. */
async function boot(
  auth: Record<string, unknown>,
  listeners: { http: boolean; prometheus: boolean },
): Promise<string> {
  const root = makeTempDir("tw-jwks-startup-");
  dirs.push(root);
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as never);
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth: { mode: "jwt", ...auth },
    transports: {
      stdio: !listeners.http,
      http: { enabled: listeners.http, host: "127.0.0.1", port: 47997 },
    },
    observability: { prometheus: { enabled: listeners.prometheus, bind: "127.0.0.1", port: 0 } },
  });
  const wiring = await wireTransports({
    config,
    version: "t",
    registry: {},
    vaultRegistry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
    acl: {},
    jobQueue: {},
    metrics: new MetricsRecorder(),
  } as unknown as Parameters<typeof wireTransports>[0]);
  await wiring.close();
  return lines.join("");
}

describe("the missing-audience deprecation is emitted on stdio-only boot too", () => {
  const noAudience = { jwks: JWKS, resource: "https://r.example/mcp" };
  it("stdio only (no HTTP, no /metrics): the same warning text", async () => {
    const out = await boot(noAudience, STDIO_ONLY);
    expect(out).toMatch(/auth: DEPRECATED: auth\.mode 'jwt' verifies tokens against a JWKS/);
    expect(out).toMatch(/allowMissingAudience/);
  });
  it("with HTTP on it is emitted exactly once, not once per call site", async () => {
    const out = await boot(noAudience, { http: true, prometheus: true });
    expect(out.match(/no audience is enforced/g)).toHaveLength(1);
  });
  it("stdio only with an audience, or the opt-out: silent", async () => {
    expect(await boot({ jwks: JWKS, audience: "https://r" }, STDIO_ONLY)).not.toMatch(/DEPRECATED/);
    expect(await boot({ ...noAudience, allowMissingAudience: true }, STDIO_ONLY)).not.toMatch(
      /DEPRECATED/,
    );
  });
});

describe("the startup lookup of auth.jwksUri", () => {
  const uri = { jwksUri: "https://as.example/jwks", audience: "https://r.example/mcp" };
  it("a resolver error/timeout says it could not verify and will retry, not REFUSED", async () => {
    setProviderResolveHostForTest(async () => {
      throw new Error("DNS lookup timed out");
    });
    const out = await boot(uri, { http: true, prometheus: false });
    expect(out).toMatch(
      /could not verify the key set at startup; will retry on each request.*DNS lookup timed out/,
    );
    expect(out).not.toMatch(/REFUSED/);
    expect(out).not.toMatch(/every asymmetric token will be rejected/);
  });
  it("a definitive policy refusal (plain http to a public host) still says REFUSED", async () => {
    setProviderResolveHostForTest(async () => [{ address: "93.184.216.34", family: 4 }]);
    const out = await boot(
      { jwksUri: "http://as.example/jwks", audience: "https://r.example/mcp" },
      { http: true, prometheus: false },
    );
    expect(out).toMatch(/auth\.jwksUri REFUSED \(every asymmetric token will be rejected\)/);
    expect(out).not.toMatch(/will retry on each request/);
  });
  it("jwksModeLine keeps REFUSED for a plain refusal and uses the retry wording when inconclusive", () => {
    expect(jwksModeLine({ ok: false, host: "h", reason: "metadata" })).toMatch(/REFUSED/);
    const retry = jwksModeLine({ ok: false, host: "h", reason: "x", inconclusive: true });
    expect(retry).toMatch(/could not verify the key set at startup; will retry on each request/);
    expect(retry).not.toMatch(/REFUSED/);
  });
});
