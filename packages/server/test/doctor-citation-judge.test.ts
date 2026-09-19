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
});
