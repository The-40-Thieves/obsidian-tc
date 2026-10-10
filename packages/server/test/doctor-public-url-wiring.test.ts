// The public-url checks join the default doctor set only when the CLI supplies the view, and the CLI
// attaches a live probe only under --probe: the default run stays offline.
import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "../src/capability";
import { publicUrlViewOf } from "../src/doctor/public-url-http";
import { assembleDoctorReport } from "../src/doctor/run";

const profile: CapabilityProfile = {
  serverVersion: "1.32.0",
  runtime: { name: "bun", version: "1.4.2", nativeModule: true },
  obsidian: { registryPath: null, installed: false, vaults: [] },
  hardware: {
    platform: "linux",
    arch: "arm64",
    cpuCount: 4,
    totalMemMb: 24000,
    hasGpu: false,
    gpus: [],
  },
};
const auth = { mode: "jwt" as const, tokenTtlSeconds: 86400, readOnly: false };

describe("publicUrlViewOf", () => {
  it("carries no probe without --probe and no resource without auth.resource", () => {
    expect(publicUrlViewOf(undefined, true)).toEqual({});
    expect(publicUrlViewOf("https://v.example.com/mcp", false)).toEqual({
      resource: "https://v.example.com/mcp",
    });
    const view = publicUrlViewOf("https://v.example.com/mcp", true);
    expect(view.resource).toBe("https://v.example.com/mcp");
    expect(typeof view.probe?.request).toBe("function");
    expect(typeof view.probe?.resolve4).toBe("function");
  });
});

describe("assembleDoctorReport: public-url", () => {
  it("is absent when the CLI supplies no view", async () => {
    const report = await assembleDoctorReport({ config: { auth }, profile });
    expect(Object.keys(report.checks).filter((k) => k.startsWith("public-url"))).toEqual([]);
  });

  it("reports a skipped check when no public URL is configured", async () => {
    const report = await assembleDoctorReport({
      config: { auth, publicUrl: publicUrlViewOf(undefined, true) },
      profile,
    });
    expect(report.checks["public-url"]?.status).toBe("ok");
  });

  it("runs every sub-check when a probe is supplied", async () => {
    const report = await assembleDoctorReport({
      config: {
        auth,
        publicUrl: {
          resource: "https://mcp.example.test/mcp",
          probe: {
            resolve4: async () => [],
            resolve6: async () => ["2001:db8::1"],
            request: async () => {
              throw new Error("unreachable");
            },
          },
        },
      },
      profile,
    });
    expect(report.checks["public-url.dns"]?.status).toBe("fail");
    expect(report.overallStatus).toBe("fail");
  });
});
