// THE-1078 — the experiential.citation-judge doctor check: gateway (default) is always ok;
// typesafe without --probe reports config-accepted-not-verified; under --probe, a reachable
// endpoint is ok and an unreachable one is a WARNING (citation-inference degrades, it doesn't
// break the server).
import { describe, expect, it } from "vitest";
import { citationJudgeCheck } from "../src/doctor/citation-judge";

const ctx = { serverVersion: "1.30.1" };

describe("experiential.citation-judge check", () => {
  it('provider "gateway" (default) is always ok, with no probe needed', async () => {
    const r = await citationJudgeCheck({ provider: "gateway" }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.judge).toContain("gateway");
  });

  it('provider "typesafe" with no probe reports config-accepted, not verified', async () => {
    const r = await citationJudgeCheck({ provider: "typesafe", model: "jev-1.13.0" }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("not probed");
    expect(r.details?.judge).toContain("jev-1.13.0");
  });

  it('provider "typesafe" under --probe is ok when the probe succeeds', async () => {
    const r = await citationJudgeCheck({
      provider: "typesafe",
      model: "jev-1.13.0",
      probe: async () => ({ ok: true, latencyMs: 42, status: 200 }),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.judge).toContain("42ms");
  });

  it('provider "typesafe" under --probe is a WARNING (not fail) when unreachable, and never leaks a key', async () => {
    const r = await citationJudgeCheck({
      provider: "typesafe",
      model: "jev-1.13.0",
      probe: async () => ({ ok: false, status: 401, reason: "HTTP 401" }),
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("typesafe");
    expect(r.remediation).toBeTruthy();
    // Never the key itself — apiKeyEnv/apiKey as FIELD NAMES in remediation prose are fine and
    // expected; a raw "Bearer <token>" value is not.
    expect(JSON.stringify(r)).not.toMatch(/Bearer\s+\S/i);
  });

  // THE-1084: allowPlainHttp on a non-loopback http:// baseUrl is a config fact, not a network
  // one — it warns with or without --probe, and never fails the check outright.
  describe("allowPlainHttp warning (THE-1084)", () => {
    it("warns, without --probe, when allowPlainHttp is set and baseUrl is non-loopback http://", async () => {
      const r = await citationJudgeCheck({
        provider: "typesafe",
        model: "jev-1.13.0",
        baseUrl: "http://litellm:4000/typesafe",
        allowPlainHttp: true,
      }).run(ctx);
      expect(r.status).toBe("warning");
      expect(r.issues?.join(" ")).toMatch(/plain http.*allowPlainHttp.*litellm/i);
    });

    it("stays ok when allowPlainHttp is set but baseUrl is loopback", async () => {
      const r = await citationJudgeCheck({
        provider: "typesafe",
        model: "jev-1.13.0",
        baseUrl: "http://127.0.0.1:8000",
        allowPlainHttp: true,
      }).run(ctx);
      expect(r.status).toBe("ok");
      expect(r.issues).toBeUndefined();
    });

    it("stays ok when baseUrl is https, regardless of allowPlainHttp", async () => {
      const r = await citationJudgeCheck({
        provider: "typesafe",
        model: "jev-1.13.0",
        baseUrl: "https://api.typesafe.ai",
        allowPlainHttp: true,
      }).run(ctx);
      expect(r.status).toBe("ok");
      expect(r.issues).toBeUndefined();
    });

    it("warns under --probe too, even when the probe itself succeeds", async () => {
      const r = await citationJudgeCheck({
        provider: "typesafe",
        model: "jev-1.13.0",
        baseUrl: "http://litellm:4000/typesafe",
        allowPlainHttp: true,
        probe: async () => ({ ok: true, latencyMs: 12, status: 200 }),
      }).run(ctx);
      expect(r.status).toBe("warning");
      expect(r.issues?.join(" ")).toMatch(/plain http/i);
    });

    it("never fails outright — status is warning, not fail", async () => {
      const r = await citationJudgeCheck({
        provider: "typesafe",
        model: "jev-1.13.0",
        baseUrl: "http://litellm:4000/typesafe",
        allowPlainHttp: true,
      }).run(ctx);
      expect(r.status).not.toBe("fail");
    });
  });
});
