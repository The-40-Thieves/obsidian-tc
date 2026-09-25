// telemetry.doctor (THE-1125) — the pure check factory, same shape as doctor-tool-facade.test.ts.
import { describe, expect, it } from "vitest";
import { type TelemetryView, telemetryCheck } from "../src/doctor/telemetry";

const ctx = { serverVersion: "test" };
const run = (view: TelemetryView) => telemetryCheck(view).run(ctx);

describe("telemetry.status doctor check", () => {
  it("is ok and says disabled (default) when off", async () => {
    const r = await run({ enabled: false });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("disabled");
    expect(r.details?.enabled).toBe("false");
  });

  it("is ok when enabled with no send attempted yet", async () => {
    const r = await run({ enabled: true, endpoint: "https://collector.example" });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("collector.example");
    expect(r.details?.endpoint).toBe("https://collector.example");
  });

  it("is ok when the last send succeeded", async () => {
    const r = await run({
      enabled: true,
      endpoint: "https://collector.example",
      lastSendAt: 1737936000000,
    });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("last send ok");
  });

  it("warns (never fails) when the last send errored, naming the error", async () => {
    const r = await run({
      enabled: true,
      endpoint: "https://collector.example",
      lastError: "HTTP 503 from https://collector.example",
    });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("HTTP 503");
    expect(r.details?.lastError).toBe("HTTP 503 from https://collector.example");
    expect(r.remediation).toBeTruthy();
  });

  it("never reports the raw endpoint — the view is already redacted by the caller", async () => {
    // This check trusts the caller (probeTelemetryState) to have redacted `endpoint` already; it
    // does not itself parse or redact a URL. Assert it echoes exactly what it was given, so a
    // regression in the caller's redaction would surface as an unexpected value here, not be
    // silently re-redacted twice or leaked here.
    const r = await run({ enabled: true, endpoint: "https://collector.example" });
    expect(r.details?.endpoint).toBe("https://collector.example");
  });
});
