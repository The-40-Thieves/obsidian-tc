// How JWT mode's remote key set is fetched, reported three ways from ONE decision
// (auth/jwks-network.ts): the startup line, the `auth.jwks-uri` doctor check, and the deprecation
// lines server_health carries. A key set that works only because an unlisted host resolves to a
// private address is a deprecation (like an unlisted plain-http provider host); a refused one fails.
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { describeJwksTarget } from "../src/auth/jwks-network";
import { authJwksCheck } from "../src/doctor/auth-jwks";
import { plainHttpEndpointDeprecations } from "../src/doctor/plain-http";
import {
  configureProviderPlainHttp,
  setProviderResolveHostForTest,
} from "../src/gateway/provider-fetch";
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
  configureProviderPlainHttp([]);
  setProviderResolveHostForTest(undefined);
});

const resolverOf =
  (table: Record<string, string[]>) =>
  async (host: string): Promise<{ address: string; family: 4 | 6 }[]> =>
    (table[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const run = (
  uri: string | undefined,
  hosts: string[],
  table: Record<string, string[]>,
  mode = "jwt" as const,
) =>
  authJwksCheck({
    authMode: mode,
    jwksUri: uri,
    describe: () =>
      describeJwksTarget(uri ?? "", { plainHttpHosts: hosts, resolveHost: resolverOf(table) }),
  }).run({ serverVersion: "t" });

describe("doctor: auth.jwks-uri", () => {
  it("is not in use without a jwksUri or outside jwt mode", async () => {
    expect((await run(undefined, [], {})).status).toBe("ok");
    expect(
      (await run("https://as.test/j", [], { "as.test": ["93.184.216.34"] }, "oidc" as never))
        .summary,
    ).toMatch(/not in use/);
  });

  it("ok and says it is pinned for a public https key set", async () => {
    const r = await run("https://as.test/j", [], { "as.test": ["93.184.216.34"] });
    expect(r.status).toBe("ok");
    expect(r.summary).toMatch(/pinned.*public/);
  });

  it("ok for loopback and for a listed tailnet host, and says which", async () => {
    expect((await run("http://127.0.0.1:9/j", [], {})).summary).toMatch(/loopback/);
    const listed = await run("http://keys.ts.test/j", ["keys.ts.test"], {
      "keys.ts.test": ["100.64.0.5"],
    });
    expect(listed.status).toBe("ok");
    expect(listed.summary).toMatch(/listed in network\.plainHttpHosts/);
  });

  it("WARNS (deprecated) for an unlisted private host, naming the host and the config to add, never the path", async () => {
    const r = await run("http://keys.lan.test/jwks/SECRET?t=SECRET2", [], {
      "keys.lan.test": ["192.168.1.10"],
    });
    expect(r.status).toBe("warning");
    expect(JSON.stringify(r)).toContain("keys.lan.test");
    expect(JSON.stringify(r)).toContain("network.plainHttpHosts");
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });

  it("FAILS for a refused key set: public over plain http, metadata even when listed", async () => {
    const pub = await run("http://as.test/j", ["as.test"], { "as.test": ["93.184.216.34"] });
    expect(pub.status).toBe("fail");
    const meta = await run("http://meta.test/j", ["meta.test"], {
      "meta.test": ["169.254.169.254"],
    });
    expect(meta.status).toBe("fail");
    expect(meta.remediation).toBeDefined();
  });
});

describe("server_health deprecations carry the key-set advice", () => {
  const cfg = (jwksUri: string, hosts: string[] = []) => ({
    vaults: [],
    network: { plainHttpHosts: hosts },
    auth: { mode: "jwt" as const, jwksUri },
  });

  it("an unlisted private key-set host is a deprecation line; listing it clears it", async () => {
    const table = { "keys.lan.test": ["192.168.1.10"] };
    const advice = await plainHttpEndpointDeprecations(
      cfg("http://keys.lan.test/jwks"),
      resolverOf(table),
    );
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatch(/auth\.jwksUri host keys\.lan\.test/);
    expect(advice[0]).toContain("network.plainHttpHosts");
    expect(
      await plainHttpEndpointDeprecations(
        cfg("http://keys.lan.test/jwks", ["keys.lan.test"]),
        resolverOf(table),
      ),
    ).toEqual([]);
  });

  it("a refused key set is reported; a public https one is silent", async () => {
    const refused = await plainHttpEndpointDeprecations(
      cfg("https://meta.test/jwks"),
      resolverOf({ "meta.test": ["169.254.169.254"] }),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/auth\.jwksUri: JWKS fetch refused/);
    expect(
      await plainHttpEndpointDeprecations(
        cfg("https://as.test/jwks"),
        resolverOf({ "as.test": ["93.184.216.34"] }),
      ),
    ).toEqual([]);
  });

  it("is silent outside jwt mode", async () => {
    const advice = await plainHttpEndpointDeprecations(
      { vaults: [], auth: { mode: "none" as const, jwksUri: "http://keys.lan.test/jwks" } },
      resolverOf({ "keys.lan.test": ["192.168.1.10"] }),
    );
    expect(advice).toEqual([]);
  });
});

describe("startup line", () => {
  async function startLine(jwksUri: string, hosts: string[], table: Record<string, string[]>) {
    const root = makeTempDir("jwks-startup-");
    dirs.push(root);
    configureProviderPlainHttp(hosts);
    setProviderResolveHostForTest(resolverOf(table));
    const config = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: root }],
      cacheDir: join(root, "cache"),
      auth: { mode: "jwt", jwksUri, audience: "https://obsidian-tc.example" },
      network: { plainHttpHosts: hosts },
      transports: { stdio: false, http: { enabled: true, host: "127.0.0.1", port: 47997 } },
    });
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      lines.push(String(s));
      return true;
    }) as never);
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
    return lines.filter((l) => l.includes("auth.jwksUri"));
  }

  it("says the key set is pinned to the validated public address", async () => {
    const lines = await startLine("https://as.test/jwks", [], { "as.test": ["93.184.216.34"] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/auth: jwt auth\.jwksUri pinned/);
  });

  it("warns DEPRECATED for an unlisted private host and is quiet once it is listed", async () => {
    const table = { "keys.lan.test": ["192.168.1.10"] };
    const dep = await startLine("http://keys.lan.test/jwks", [], table);
    expect(dep[0]).toMatch(/DEPRECATED/);
    expect(dep[0]).toContain("keys.lan.test");
    const listed = await startLine("http://keys.lan.test/jwks", ["keys.lan.test"], table);
    expect(listed[0]).toMatch(/listed in network\.plainHttpHosts/);
    expect(listed[0]).not.toMatch(/DEPRECATED/);
  });
});
