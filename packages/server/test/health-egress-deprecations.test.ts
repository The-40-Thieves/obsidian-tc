// server_health.deprecations, release review findings:
//  - it named cross-vault ids and internal hostnames to an anonymous or vault-bound caller;
//  - its advice came from the config alone (no DNS), so it told the operator to list hosts that the
//    policy then SENDS to (an unlisted host on 100.64/10 becomes a tailnet peer once listed), and it
//    claimed public and metadata hosts "work" when listing them enables nothing.
import { describe, expect, it } from "vitest";
import { plainHttpEndpointDeprecations } from "../src/doctor/plain-http";
import { healthToolsWiringFields } from "../src/mcp/facade-auto";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool, type HealthInfo } from "../src/tools/admin/health";

const resolverOf =
  (table: Record<string, string[]>) =>
  async (host: string): Promise<{ address: string; family: 4 | 6 }[]> =>
    (table[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const ctxBase = {
  caller: null,
  grantedScopes: new Set<string>(),
  vaultId: "vault-a",
  db: {} as never,
};
const anonymous = { ...ctxBase, authenticated: false } as unknown as CallerContext;
const vaultBound = {
  ...ctxBase,
  authenticated: true,
  vaultBound: true,
} as unknown as CallerContext;
const admin = { ...ctxBase, authenticated: true } as unknown as CallerContext;

const cfgWithSecretVault = {
  vaults: [{ id: "vault-a" }, { id: "secret-vault", restApiUrl: "http://secret-obsidian:27123" }],
  toolFacade: { mode: "triad" as const, profile: "full" as const },
  experiential: { citationInfer: { judge: { provider: "typesafe", allowPlainHttp: true } } },
};

async function healthFor(ctx: CallerContext): Promise<HealthInfo> {
  const advice = await plainHttpEndpointDeprecations(
    cfgWithSecretVault,
    resolverOf({ "secret-obsidian": ["172.18.0.9"] }),
  );
  const wiring = healthToolsWiringFields(cfgWithSecretVault, undefined, undefined, advice);
  const tool = createHealthTool({
    version: "t",
    vaults: ["vault-a", "secret-vault"],
    startedAt: 0,
    nativeLoaded: false,
    vecEnabled: false,
    ...(wiring.deprecations ? { deprecations: wiring.deprecations } : {}),
  });
  return tool.handler({}, ctx) as HealthInfo;
}

describe("server_health deprecations are behind the same gate as the vault list", () => {
  it.each([
    ["an anonymous caller", anonymous],
    ["a vault-bound token", vaultBound],
  ])("%s learns neither a vault id nor an internal hostname nor an address", async (_n, ctx) => {
    const out = await healthFor(ctx);
    const text = JSON.stringify(out);
    for (const secret of ["secret-vault", "secret-obsidian", "172.18.0.9", "restApiUrl"]) {
      expect(text, secret).not.toContain(secret);
    }
    // It still learns that something is deprecated, as a count in one generic line.
    expect(out.deprecations).toHaveLength(1);
    expect(out.deprecations?.[0]).toMatch(/2 deprecation notices/);
    expect(out.deprecations?.[0]).toMatch(/withheld/i);
    expect(out.deprecations?.[0]).toMatch(/doctor|administrator/i);
  });

  it("a caller that may see every vault gets the full detail", async () => {
    const out = await healthFor(admin);
    expect(out.deprecations).toHaveLength(2);
    expect(out.deprecations?.join("\n")).toMatch(
      /experiential\.citationInfer\.judge\.allowPlainHttp is deprecated/,
    );
    expect(out.deprecations?.join("\n")).toMatch(
      /vaults\[secret-vault\]\.restApiUrl.*secret-obsidian/,
    );
  });

  it("no deprecations: the field is absent for everyone", async () => {
    const tool = createHealthTool({
      version: "t",
      vaults: ["vault-a"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
    });
    expect((tool.handler({}, anonymous) as HealthInfo).deprecations).toBeUndefined();
  });
});

describe("plainHttpEndpointDeprecations classifies with the doctor's resolver and logic", () => {
  const cfg = (baseUrl: string, hosts: string[] = []) => ({
    vaults: [],
    network: { plainHttpHosts: hosts },
    embeddings: { provider: "openai-compatible", baseUrl },
  });
  const advice = (baseUrl: string, table: Record<string, string[]>, hosts: string[] = []) =>
    plainHttpEndpointDeprecations(cfg(baseUrl, hosts), resolverOf(table));

  it("an unlisted host on 100.64/10 is NOT told to list it as a plain 'add this host'; it is refused", async () => {
    const [line, ...rest] = await advice("http://embedder.example", {
      "embedder.example": ["100.100.100.100"],
    });
    expect(rest).toEqual([]);
    expect(line).toMatch(/^embeddings\.baseUrl: /);
    expect(line).toMatch(/refused/i);
    expect(line).toMatch(/list it only if it is a tailnet peer/i);
    expect(line).not.toMatch(/works only because/);
  });

  it.each([
    ["a public host", "http://8.8.8.8", {}],
    ["the metadata address", "http://169.254.169.254", {}],
    ["an IPv6 metadata address", "http://[fd00:ec2::254]", {}],
    ["a name resolving public", "http://pub.example", { "pub.example": ["93.184.216.34"] }],
    [
      "a name resolving to metadata",
      "http://imds.example",
      { "imds.example": ["169.254.169.254"] },
    ],
  ])(
    "%s is 'refused: use https', never 'works' and never 'add the host'",
    async (_n, url, table) => {
      const lines = await advice(url, table);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/refused/i);
      expect(lines[0]).toMatch(/use https/i);
      expect(lines[0]).not.toMatch(/works only because/);
      expect(lines[0]).not.toMatch(/add ".*" to network\.plainHttpHosts/);
    },
  );

  it("a listed host resolving public is still refused (listing never helps)", async () => {
    const lines = await advice("http://pub.example", { "pub.example": ["93.184.216.34"] }, [
      "pub.example",
    ]);
    expect(lines[0]).toMatch(/refused.*use https|use https.*refused|refused/i);
  });

  it.each([
    ["RFC1918", "172.18.0.9"],
    ["IPv6 unique-local", "fd12:3456::1"],
  ])("an unlisted host resolving only to %s is the one case told to list it", async (_n, ip) => {
    const lines = await advice("http://lan.example", { "lan.example": [ip] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/add "lan\.example" to network\.plainHttpHosts/);
  });

  it("a host with a private AND a CGNAT answer, unlisted, is refused, not advised", async () => {
    const lines = await advice("http://mixed.example", {
      "mixed.example": ["172.18.0.9", "100.100.100.100"],
    });
    expect(lines[0]).toMatch(/refused/i);
    expect(lines[0]).not.toMatch(/works only because/);
  });

  it("an unresolvable host says so", async () => {
    const lines = await advice("http://gone.example", {});
    expect(lines[0]).toMatch(/did not resolve/);
  });

  it.each([
    ["listed, private", "http://litellm:4000", { litellm: ["172.18.0.5"] }, ["litellm"]],
    ["listed, tailnet", "http://peer:4000", { peer: ["100.64.0.7"] }, ["peer"]],
    ["loopback", "http://127.0.0.1:8080", {}, []],
    ["https", "https://api.example.com", {}, []],
  ])("nothing to say about a %s endpoint", async (_n, url, table, hosts) => {
    expect(await advice(url, table, hosts)).toEqual([]);
  });

  it("a resolver that throws is a refusal line, not a crash", async () => {
    const lines = await plainHttpEndpointDeprecations(cfg("http://boom.example"), async () => {
      throw new Error("ESERVFAIL");
    });
    expect(lines[0]).toMatch(/did not resolve/);
  });
});
