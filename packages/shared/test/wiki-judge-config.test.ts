// wikiJudge config: the lint judge defaults ON (it still needs a configured judge to run), the
// find_existing_page judge stays default OFF, and provider "typesafe" carries the same pinned-model /
// threshold / https-unless-loopback-unless-allowPlainHttp rules as experiential.citationInfer.judge.
import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "../src/index";

const base = { vaults: [{ id: "main", path: "/v" }] };
const parse = (wikiJudge: Record<string, unknown>) => ServerConfigSchema.parse({ ...base, wikiJudge });
const typesafe = (extra: Record<string, unknown> = {}) =>
  parse({ provider: "typesafe", model: "jev-1.13.0", threshold: 0.6, ...extra });

describe("wikiJudge defaults", () => {
  it("lint judge ON, find_existing_page judge OFF, gateway provider, scheduled sweep judge ON", () => {
    const c = ServerConfigSchema.parse(base);
    expect(c.wikiJudge.lintEnabled).toBe(true);
    expect(c.wikiJudge.enabled).toBe(false);
    expect(c.wikiJudge.provider).toBe("gateway");
    expect(c.wikiJudge.model).toBeUndefined();
    expect(c.wikiJudge.threshold).toBeUndefined();
    expect(c.wikiJudge.baseUrl).toBe("https://api.typesafe.ai");
    expect(c.wikiJudge.apiKeyEnv).toBe("TYPESAFE_API_KEY");
    expect(c.wikiJudge.allowPlainHttp).toBe(false);
    expect(c.maintenance.wikiLint.judge).toBe(true);
    // The sweep itself stays opt-in.
    expect(c.maintenance.wikiLint.enabled).toBe(false);
  });
});

describe("wikiJudge.provider typesafe", () => {
  it("accepts a pinned dotted model with a threshold", () => {
    const c = typesafe();
    expect(c.wikiJudge.provider).toBe("typesafe");
    expect(c.wikiJudge.model).toBe("jev-1.13.0");
    expect(c.wikiJudge.threshold).toBe(0.6);
  });

  it.each(["jev-latest", "jev-preview", "jev", "jev-1", "jev-1.13.0-rc", "latest", "jev-1.x"])(
    "rejects the unpinned model %s",
    (model) => {
      expect(() => typesafe({ model })).toThrow(/pinned, versioned/);
    },
  );

  it("requires a model", () => {
    expect(() => parse({ provider: "typesafe", threshold: 0.6 })).toThrow(/wikiJudge\.model is required/);
  });

  it("requires a threshold (no default)", () => {
    expect(() => parse({ provider: "typesafe", model: "jev-1.13.0" })).toThrow(
      /wikiJudge\.threshold is required/,
    );
  });

  it("bounds the threshold to 0..1", () => {
    expect(() => typesafe({ threshold: 1.5 })).toThrow();
    expect(() => typesafe({ threshold: -0.1 })).toThrow();
  });

  it("a gateway provider may carry any model string: it is the gateway's, not checked here", () => {
    expect(parse({ provider: "gateway", model: "jev-latest" }).wikiJudge.model).toBe("jev-latest");
  });

  it("refuses a non-loopback http:// baseUrl unless allowPlainHttp is set", () => {
    expect(() => typesafe({ baseUrl: "http://litellm:4000/typesafe" })).toThrow(
      /wikiJudge\.baseUrl must use https/,
    );
    const ok = typesafe({ baseUrl: "http://litellm:4000/typesafe", allowPlainHttp: true });
    expect(ok.wikiJudge.baseUrl).toBe("http://litellm:4000/typesafe");
  });

  it("accepts https and a loopback http:// baseUrl without the flag", () => {
    expect(typesafe({ baseUrl: "https://gateway.example/typesafe" }).wikiJudge.allowPlainHttp).toBe(
      false,
    );
    expect(typesafe({ baseUrl: "http://127.0.0.1:8000" }).wikiJudge.baseUrl).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("refuses a non-http(s) scheme even with allowPlainHttp", () => {
    expect(() => typesafe({ baseUrl: "ftp://example.com", allowPlainHttp: true })).toThrow();
  });
});
