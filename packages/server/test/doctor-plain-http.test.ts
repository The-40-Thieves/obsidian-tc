// egress.plain-http doctor check: every plain-http endpoint with the address(es) its host resolves
// to, a warning for any address that is not private, and the allowPlainHttp deprecation.
import { describe, expect, it } from "vitest";
import {
  plainHttpCheck,
  plainHttpDeprecations,
  plainHttpEndpointDeprecations,
  plainHttpEndpoints,
} from "../src/doctor/plain-http";
import type { ResolveHost } from "../src/gateway/plain-http";

const ctx = { serverVersion: "1.31.8" };
const resolver =
  (map: Record<string, string[]>): ResolveHost =>
  async (h) => {
    const a = map[h];
    if (!a) throw new Error("ENOTFOUND");
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

describe("egress.plain-http", () => {
  it("is ok and says so when nothing uses plain http", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "https://api.typesafe.ai" }],
      resolveHost: resolver({}),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("no configured endpoint");
  });

  it("lists loopback http as allowed and does not count it as leaving the machine", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "http://127.0.0.1:9000" }],
      resolveHost: resolver({}),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("nothing leaves this machine");
    expect(r.details?.endpoints).toEqual(["wikiJudge: 127.0.0.1 -> 127.0.0.1 [allowed]"]);
  });

  it("lists a listed private host with its resolved address and stays ok", async () => {
    const r = await plainHttpCheck({
      endpoints: [
        {
          field: "experiential.citationInfer.judge",
          baseUrl: "http://litellm:4000/typesafe",
          plainHttpHosts: ["litellm"],
        },
      ],
      resolveHost: resolver({ litellm: ["172.18.0.5"] }),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.endpoints).toEqual([
      "experiential.citationInfer.judge: litellm -> 172.18.0.5 [allowed]",
    ]);
  });

  it("warns when any resolved address is not private, naming it", async () => {
    const r = await plainHttpCheck({
      endpoints: [
        { field: "wikiJudge", baseUrl: "http://example.com", plainHttpHosts: ["example.com"] },
      ],
      resolveHost: resolver({ "example.com": ["172.18.0.5", "93.184.216.34"] }),
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/93\.184\.216\.34.*not a private address/);
    expect(r.details?.endpoints?.[0]).toContain("[refused]");
  });

  it("treats the cloud metadata address as not private", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "http://meta", plainHttpHosts: ["meta"] }],
      resolveHost: resolver({ meta: ["169.254.169.254"] }),
    }).run(ctx);
    expect(r.status).toBe("warning");
  });

  it("lists IP-literal hosts as themselves, without a lookup", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "http://0x08080808/", allowPlainHttp: true }],
      resolveHost: resolver({}),
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.details?.endpoints?.[0]).toBe("wikiJudge: 8.8.8.8 -> 8.8.8.8 [refused]");
  });

  it("warns when the host does not resolve", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "http://gone", plainHttpHosts: ["gone"] }],
      resolveHost: resolver({}),
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/did not resolve/);
  });

  it("warns that allowPlainHttp is deprecated, even for a private host", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "http://litellm:4000", allowPlainHttp: true }],
      resolveHost: resolver({ litellm: ["172.18.0.5"] }),
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/wikiJudge\.allowPlainHttp is deprecated.*next major/);
    expect(r.issues?.join(" ")).toMatch(/plainHttpHosts/);
  });

  it("a plain-http host that is not listed is flagged", async () => {
    const r = await plainHttpCheck({
      endpoints: [
        { field: "wikiJudge", baseUrl: "http://litellm:4000", plainHttpHosts: ["other"] },
      ],
      resolveHost: resolver({ litellm: ["172.18.0.5"] }),
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/not listed in wikiJudge\.plainHttpHosts/);
  });
});

describe("plainHttpEndpoints / plainHttpDeprecations", () => {
  const cfg = {
    experiential: {
      citationInfer: {
        judge: {
          provider: "typesafe",
          baseUrl: "http://litellm:4000",
          plainHttpHosts: ["litellm"],
          allowPlainHttp: true,
        },
      },
    },
    wikiJudge: { provider: "gateway", baseUrl: "https://api.typesafe.ai", allowPlainHttp: true },
  };

  it("only a typesafe-provider block counts", () => {
    expect(plainHttpEndpoints(cfg).map((e) => e.field)).toEqual([
      "experiential.citationInfer.judge",
    ]);
    expect(plainHttpDeprecations(cfg)).toEqual([
      expect.stringContaining("experiential.citationInfer.judge.allowPlainHttp is deprecated"),
    ]);
  });

  it("reports nothing when the flag is unset", () => {
    expect(
      plainHttpDeprecations({ wikiJudge: { provider: "typesafe", allowPlainHttp: false } }),
    ).toEqual([]);
  });
});

describe("egress.plain-http: provider endpoints", () => {
  const providerEp = (field: string, baseUrl: string, hosts: string[] = []) => ({
    field,
    baseUrl,
    plainHttpHosts: hosts,
    kind: "provider" as const,
  });

  it("lists each plaintext provider host with its address and a status: allowed, deprecated-unlisted, refused", async () => {
    const r = await plainHttpCheck({
      endpoints: [
        providerEp("gateway.baseUrl", "http://litellm:4000", ["litellm"]),
        providerEp("embeddings.baseUrl", "http://emb.lan:8080"),
        providerEp("reranker.baseUrl", "http://rank.example.com/v2"),
        providerEp("plur.endpoint", "http://127.0.0.1:7077"),
      ],
      resolveHost: resolver({
        litellm: ["172.18.0.5"],
        "emb.lan": ["192.168.1.9"],
        "rank.example.com": ["93.184.216.34"],
      }),
    }).run(ctx);
    expect(r.details?.endpoints).toEqual([
      "gateway.baseUrl: litellm -> 172.18.0.5 [allowed]",
      "embeddings.baseUrl: emb.lan -> 192.168.1.9 [deprecated-unlisted]",
      "reranker.baseUrl: rank.example.com -> 93.184.216.34 [refused]",
      "plur.endpoint: 127.0.0.1 -> 127.0.0.1 [allowed]",
    ]);
    expect(r.status).toBe("warning");
    const issues = r.issues?.join("\n") ?? "";
    // The deprecation names the host and the config to add.
    expect(issues).toMatch(/embeddings\.baseUrl: .*emb\.lan.*network\.plainHttpHosts/);
    expect(issues).toMatch(/refused from the next major/);
    // The refusal names the address.
    expect(issues).toMatch(/reranker\.baseUrl: rank\.example\.com resolves to 93\.184\.216\.34/);
    // The allowed ones are not complaints.
    expect(issues).not.toMatch(/gateway\.baseUrl/);
    expect(issues).not.toMatch(/plur\.endpoint/);
  });

  it("a listed host that resolves to a public address is refused, and the cloud metadata address is never allowed", async () => {
    const r = await plainHttpCheck({
      endpoints: [
        providerEp("embeddings.baseUrl", "http://emb.example.com", ["emb.example.com"]),
        providerEp("gateway.baseUrl", "http://meta", ["meta"]),
      ],
      resolveHost: resolver({ "emb.example.com": ["93.184.216.34"], meta: ["169.254.169.254"] }),
    }).run(ctx);
    expect(r.details?.endpoints).toEqual([
      "embeddings.baseUrl: emb.example.com -> 93.184.216.34 [refused]",
      "gateway.baseUrl: meta -> 169.254.169.254 [refused]",
    ]);
  });

  it("a listed host on a tailnet/CGNAT address is allowed (listed tailnet/CGNAT); an unlisted one is refused with no deprecation", async () => {
    const r = await plainHttpCheck({
      endpoints: [
        providerEp("gateway.baseUrl", "http://ts-peer:4000", ["ts-peer"]),
        providerEp("embeddings.baseUrl", "http://ts-other:8080"),
      ],
      resolveHost: resolver({ "ts-peer": ["100.101.102.103"], "ts-other": ["100.64.0.1"] }),
    }).run(ctx);
    expect(r.details?.endpoints).toEqual([
      "gateway.baseUrl: ts-peer -> 100.101.102.103 [allowed (listed tailnet/CGNAT)]",
      "embeddings.baseUrl: ts-other -> 100.64.0.1 [refused]",
    ]);
    const issues = r.issues?.join("\n") ?? "";
    expect(issues).toMatch(
      /embeddings\.baseUrl: ts-other .*100\.64\.0\.1.*network\.plainHttpHosts/,
    );
    expect(issues).not.toMatch(/deprecated|next major/);
    expect(issues).not.toMatch(/gateway\.baseUrl/);
    // A judge block's own list admits a listed tailnet host the same way.
    const j = await plainHttpCheck({
      endpoints: [
        {
          field: "wikiJudge",
          baseUrl: "http://ts-peer:4000/typesafe",
          plainHttpHosts: ["ts-peer"],
        },
      ],
      resolveHost: resolver({ "ts-peer": ["100.101.102.103"] }),
    }).run(ctx);
    expect(j.details?.endpoints).toEqual([
      "wikiJudge: ts-peer -> 100.101.102.103 [allowed (listed tailnet/CGNAT)]",
    ]);
    expect(j.status).toBe("ok");
  });

  it("an https provider URL is not a plaintext endpoint", async () => {
    const r = await plainHttpCheck({
      endpoints: [providerEp("embeddings.baseUrl", "https://api.openai.com/v1")],
      resolveHost: resolver({}),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("no configured endpoint");
  });
});

describe("plainHttpEndpoints: every provider client's baseUrl", () => {
  const base = {
    experiential: { citationInfer: {} },
    wikiJudge: { provider: "gateway", baseUrl: "https://api.typesafe.ai" },
  };

  it("enumerates the gateway, embeddings, reranker, plur and per-vault bridge URLs", () => {
    const cfg = {
      ...base,
      network: { plainHttpHosts: ["litellm"] },
      gateway: { baseUrl: "http://litellm:4000" },
      embeddings: { provider: "openai-compatible", baseUrl: "http://litellm:4000/v1" },
      reranker: { provider: "cohere-compatible", baseUrl: "http://rank:9000/v2" },
      plur: { endpoint: "http://plur:7077" },
      vaults: [{ id: "main", restApiUrl: "http://obsidian:27123" }, { id: "none" }],
    };
    const eps = plainHttpEndpoints(cfg);
    expect(eps.map((e) => e.field)).toEqual([
      "gateway.baseUrl",
      "embeddings.baseUrl",
      "reranker.baseUrl",
      "plur.endpoint",
      "vaults[main].restApiUrl",
    ]);
    expect(eps.every((e) => e.kind === "provider")).toBe(true);
    expect(eps.every((e) => e.plainHttpHosts?.[0] === "litellm")).toBe(true);
  });

  it("model-tier reads its two service URLs, not embeddings.baseUrl; local and module read none", () => {
    const tier = {
      ...base,
      embeddings: {
        provider: "model-tier",
        baseUrl: "http://ignored:1",
        modelTier: { dense: { baseUrl: "http://tei:80" }, full: { baseUrl: "http://bge:8000" } },
      },
    };
    expect(plainHttpEndpoints(tier).map((e) => e.field)).toEqual([
      "embeddings.modelTier.dense.baseUrl",
      "embeddings.modelTier.full.baseUrl",
    ]);
    expect(
      plainHttpEndpoints({ ...base, embeddings: { provider: "local", baseUrl: "http://x:1" } }),
    ).toEqual([]);
  });

  it("plainHttpDeprecations is the config-only half: allowPlainHttp lines, no host names", () => {
    const out = plainHttpDeprecations({
      ...base,
      network: { plainHttpHosts: ["litellm"] },
      gateway: { baseUrl: "http://litellm:4000" },
      embeddings: { provider: "openai-compatible", baseUrl: "http://emb.lan:8080/v1" },
      wikiJudge: { provider: "typesafe", allowPlainHttp: true },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^wikiJudge\.allowPlainHttp is deprecated/);
    expect(out[0]).not.toContain("emb.lan");
  });

  it("plainHttpEndpointDeprecations names each unlisted private provider host and the config to add", async () => {
    const out = await plainHttpEndpointDeprecations(
      {
        ...base,
        network: { plainHttpHosts: ["litellm"] },
        gateway: { baseUrl: "http://litellm:4000" },
        embeddings: { provider: "openai-compatible", baseUrl: "http://emb.lan:8080/v1" },
        plur: { endpoint: "http://127.0.0.1:7077" },
      },
      resolver({ litellm: ["172.18.0.5"], "emb.lan": ["192.168.1.20"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^embeddings\.baseUrl: .*emb\.lan/);
    expect(out[0]).toContain('add "emb.lan" to network.plainHttpHosts');
  });
});
