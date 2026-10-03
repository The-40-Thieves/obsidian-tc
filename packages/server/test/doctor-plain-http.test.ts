// egress.plain-http doctor check: every plain-http endpoint with the address(es) its host resolves
// to, a warning for any address that is not private, and the allowPlainHttp deprecation.
import { describe, expect, it } from "vitest";
import {
  plainHttpCheck,
  plainHttpDeprecations,
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

  it("loopback http is not a plaintext endpoint", async () => {
    const r = await plainHttpCheck({
      endpoints: [{ field: "wikiJudge", baseUrl: "http://127.0.0.1:9000" }],
      resolveHost: resolver({}),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details).toBeUndefined();
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
      "experiential.citationInfer.judge: litellm -> 172.18.0.5",
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
    expect(r.details?.endpoints?.[0]).toContain("NOT PRIVATE");
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
    expect(r.details?.endpoints?.[0]).toBe("wikiJudge: 8.8.8.8 -> 8.8.8.8 (NOT PRIVATE)");
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
