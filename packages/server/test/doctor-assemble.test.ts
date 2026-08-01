// THE-521: the assembler wires config + capability profile + optional deployed token into the default
// check set and runs it. Also the JWT-claims decoder: doctor reads a token's iat/exp to run auth.maxAge
// WITHOUT verifying it (verification needs the secret; the claims are enough to see the age math). It
// must be defensive — a garbage --token argument degrades to "no token", never a throw.
import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "../src/capability";
import { assembleDoctorReport, decodeTokenClaims } from "../src/doctor/run";

const profile: CapabilityProfile = {
  serverVersion: "1.10.0",
  runtime: { name: "bun", version: "1.3.14", nativeModule: true },
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

const config = { auth: { mode: "jwt" as const, tokenTtlSeconds: 86400, readOnly: false } };

function makeJwt(claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.signature-not-checked`;
}

describe("THE-521 decodeTokenClaims", () => {
  it("extracts iat and exp from a well-formed JWT without verifying it", () => {
    const c = decodeTokenClaims(makeJwt({ iat: 1000, exp: 2000, sub: "agent" }));
    expect(c).toEqual({ iat: 1000, exp: 2000 });
  });

  it("returns undefined for a non-JWT string rather than throwing", () => {
    expect(decodeTokenClaims("not-a-jwt")).toBeUndefined();
    expect(decodeTokenClaims("")).toBeUndefined();
    expect(decodeTokenClaims("a.b.c")).toBeUndefined(); // b is not valid base64 JSON
  });

  it("returns undefined when iat/exp are missing", () => {
    expect(decodeTokenClaims(makeJwt({ sub: "x" }))).toBeUndefined();
  });
});

describe("THE-521 assembleDoctorReport", () => {
  it("runs the default check set keyed by stable ids", async () => {
    const report = await assembleDoctorReport({
      config,
      profile,
      now: () => "2026-07-22T00:00:00.000Z",
    });
    for (const id of [
      "runtime.versions",
      "native.availability",
      "auth.policy",
      "auth.maxAge",
      "obsidian.detection",
    ]) {
      expect(report.checks[id], `missing check ${id}`).toBeDefined();
    }
    expect(report.schemaVersion).toBe(1);
  });

  it("#16: adds retrieval.heads only when the config view supplies the retrieval readiness", async () => {
    const withoutRetrieval = await assembleDoctorReport({ config, profile, now: () => "t" });
    expect(withoutRetrieval.checks["retrieval.heads"]).toBeUndefined();

    const withRetrieval = await assembleDoctorReport({
      config: {
        ...config,
        retrieval: {
          denseProvider: "bge-m3",
          denseModel: "BAAI/bge-m3",
          denseDimensions: 1024,
          multiVector: true,
          sparseEnabled: true,
          colbertEnabled: false,
        },
      },
      profile,
      now: () => "t",
    });
    const head = withRetrieval.checks["retrieval.heads"];
    expect(head).toBeDefined();
    expect(head?.status).toBe("ok");
    // THE-688: "configured", not "ready" — the check is offline and never probes the provider.
    expect(head?.details?.sparse).toContain("configured");
    expect(head?.details?.sparse).not.toMatch(/\bready\b/);
    expect(head?.details?.colbert).toContain("off");
  });

  it("threads a supplied deployed token into auth.maxAge and catches the max-age trap", async () => {
    const iat = 1_000_000_000;
    const token = makeJwt({ iat, exp: iat + 365 * 86400 }); // exp 1y, but ttl is 1d
    const report = await assembleDoctorReport({
      config,
      profile,
      token,
      nowSeconds: () => iat + 2 * 86400, // 2 days later: past the 1-day max age
      now: () => "2026-07-22T00:00:00.000Z",
    });
    expect(report.checks["auth.maxAge"]?.status).toBe("fail");
    expect(report.checks["auth.maxAge"]?.details?.bindingConstraint).toBe("max-age");
    expect(report.overallStatus).toBe("fail");
  });

  it("runs auth.maxAge in informational mode when no token is supplied", async () => {
    const report = await assembleDoctorReport({ config, profile, now: () => "t" });
    expect(report.checks["auth.maxAge"]?.status).toBe("ok");
    expect(report.checks["auth.maxAge"]?.notes?.length).toBeGreaterThan(0);
  });

  it("final-review blocker 2: adds providers.registered only when the config view supplies it", async () => {
    const without = await assembleDoctorReport({ config, profile, now: () => "t" });
    expect(without.checks["providers.registered"]).toBeUndefined();

    const withProviders = await assembleDoctorReport({
      config: { ...config, providers: { embeddingsProvider: "ollama" } },
      profile,
      now: () => "t",
    });
    expect(withProviders.checks["providers.registered"]?.status).toBe("ok");
  });

  it("final-review blocker 2: an unregistered embeddings.provider fails the check and the overall report", async () => {
    const report = await assembleDoctorReport({
      config: { ...config, providers: { embeddingsProvider: "ollma" } },
      profile,
      now: () => "t",
    });
    expect(report.checks["providers.registered"]?.status).toBe("fail");
    expect(report.overallStatus).toBe("fail");
  });

  it("THE-648: adds snapshots.policy only when the config view supplies it", async () => {
    const without = await assembleDoctorReport({ config, profile, now: () => "t" });
    expect(without.checks["snapshots.policy"]).toBeUndefined();

    const withSnapshots = await assembleDoctorReport({
      config: { ...config, snapshots: { enabled: true, retention: 10 } },
      profile,
      now: () => "t",
    });
    expect(withSnapshots.checks["snapshots.policy"]?.status).toBe("ok");
  });
});
