// sessions.liveness (THE-1108) — is any EXPLICIT (start_session) session already older than the
// resolver's own windowSeconds bound? Mirrors doctor-entrypoint-liveness.test.ts's probe-injection
// shape: the check is pure classification over an injected probe, no live server/DB/network.
import { describe, expect, it } from "vitest";
import { type SessionLivenessView, sessionLivenessCheck } from "../src/doctor/session-liveness";

const ctx = { serverVersion: "test" };
const run = (view: SessionLivenessView) => sessionLivenessCheck(view).run(ctx);

describe("sessions.liveness", () => {
  it("reports 'not probed' when no probe was supplied — the default (non---probe) doctor run", async () => {
    const r = await run({ windowSeconds: 1800 });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("not probed");
  });

  it("is ok when no explicit session is older than windowSeconds", async () => {
    const r = await run({
      windowSeconds: 1800,
      probe: () => ({ staleExplicit: 0, oldestAgeMs: null, oldestPrincipal: null }),
    });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("no explicit session older than windowSeconds");
  });

  it("WARNS, never fails, when an explicit session is stuck past windowSeconds, and names the count/age/principal", async () => {
    const r = await run({
      windowSeconds: 1800,
      probe: () => ({
        staleExplicit: 1,
        oldestAgeMs: 34 * 86_400_000,
        oldestPrincipal: "alice",
      }),
    });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("1 explicit session");
    expect(r.details?.staleExplicit).toBe("1");
    expect(r.details?.oldestPrincipal).toBe("alice");
    expect(r.issues?.join(" ")).toContain("THE-1108");
    expect(r.remediation).toBeTruthy();
  });

  it("omits oldestPrincipal from details when the row predates principal being recorded", async () => {
    const r = await run({
      windowSeconds: 1800,
      probe: () => ({ staleExplicit: 1, oldestAgeMs: 5000, oldestPrincipal: null }),
    });
    expect(r.details?.oldestPrincipal).toBeUndefined();
  });

  it("never returns fail — a stuck-open explicit session breaks no request in flight", async () => {
    const r = await run({
      windowSeconds: 1800,
      probe: () => ({ staleExplicit: 5, oldestAgeMs: 1000, oldestPrincipal: null }),
    });
    expect(r.status).not.toBe("fail");
  });
});
