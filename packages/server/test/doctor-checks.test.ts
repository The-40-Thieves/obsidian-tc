// THE-521: the individual checks. Each is a factory returning a Check whose inputs are injected, so
// it is testable with no live server, DB, or network.
//
// The marquee is auth.maxAge — the check that would have caught the 5-day outage. tokenTtlSeconds
// caps a token's AGE from `iat`, INDEPENDENTLY of `exp` (THE-520). A token with exp in 2027 is still
// rejected once it is older than the max age, and every layer reads healthy. This check makes the
// max-age vs expiry distinction explicit: it reports both bounds and flags which one actually binds.
import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "../src/capability";
import {
  authMaxAgeCheck,
  authPolicyCheck,
  nativeCheck,
  obsidianCheck,
  type RetrievalHeadsView,
  retrievalHeadsCheck,
  runtimeCheck,
} from "../src/doctor/checks";

const ctx = { serverVersion: "1.10.0" };

const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  serverVersion: "1.10.0",
  runtime: { name: "bun", version: "1.3.14", nativeModule: true },
  obsidian: { registryPath: "/home/u/.config/obsidian/obsidian.json", installed: true, vaults: [] },
  hardware: {
    platform: "linux",
    arch: "arm64",
    cpuCount: 4,
    totalMemMb: 24000,
    hasGpu: false,
    gpus: [],
  },
  ...over,
});

describe("THE-521 runtime + native checks", () => {
  it("runtime.versions reports server, runtime and native from the profile", async () => {
    const r = await runtimeCheck(profile()).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.runtime).toContain("bun");
    expect(r.details?.serverVersion).toBe("1.10.0");
  });

  it("native.availability warns when the native module fell back to JS", async () => {
    const loaded = await nativeCheck(
      profile({ runtime: { name: "bun", version: "1", nativeModule: true } }),
    ).run(ctx);
    expect(loaded.status).toBe("ok");
    const fell = await nativeCheck(
      profile({ runtime: { name: "node", version: "24", nativeModule: false } }),
    ).run(ctx);
    expect(fell.status).toBe("warning");
    expect(fell.remediation).toBeTruthy();
  });
});

describe("THE-521 auth.policy check", () => {
  it("reports mode and the effective token max age", async () => {
    const r = await authPolicyCheck({
      mode: "jwt",
      tokenTtlSeconds: 31536000,
      readOnly: false,
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.mode).toBe("jwt");
    expect(r.details?.tokenTtlSeconds).toBe("31536000");
  });

  it("warns when auth.mode is none (every request resolves to full scopes)", async () => {
    const r = await authPolicyCheck({ mode: "none", tokenTtlSeconds: 86400, readOnly: false }).run(
      ctx,
    );
    expect(r.status).toBe("warning");
    expect(r.summary.toLowerCase()).toContain("none");
  });
});

describe("THE-521 auth.maxAge check (THE-520)", () => {
  const DAY = 86400;
  // A token minted now, exp one year out, but a 24h max-age cap — the exact outage shape.
  const iat = 1_000_000_000;
  const token = { iat, exp: iat + 365 * DAY };

  it("flags max-age as the BINDING constraint when it expires before exp", async () => {
    const r = await authMaxAgeCheck({ tokenTtlSeconds: DAY }, token, () => iat + 2 * DAY).run(ctx);
    // now is 2 days after iat: past the 1-day max age, but exp is a year out.
    expect(r.status).toBe("fail");
    expect(r.summary.toLowerCase()).toContain("max age");
    // it must name BOTH bounds so the operator sees exp is NOT the reason
    expect(r.details?.maxAgeExpiry).toBeTruthy();
    expect(r.details?.tokenExp).toBeTruthy();
    expect(r.details?.bindingConstraint).toBe("max-age");
  });

  it("warns when the token is still valid but max-age will bite before exp", async () => {
    const r = await authMaxAgeCheck({ tokenTtlSeconds: DAY }, token, () => iat + DAY / 2).run(ctx);
    // half a day in: valid, but max-age (1d) is far sooner than exp (1y) — the silent-killer setup.
    expect(r.status).toBe("warning");
    expect(r.details?.bindingConstraint).toBe("max-age");
    expect(r.remediation).toMatch(/tokenTtlSeconds/);
  });

  it("is ok when exp binds before max-age (max age is not the limiting factor)", async () => {
    const shortLived = { iat, exp: iat + DAY }; // exp 1d, max-age 1y
    const r = await authMaxAgeCheck(
      { tokenTtlSeconds: 365 * DAY },
      shortLived,
      () => iat + DAY / 2,
    ).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.bindingConstraint).toBe("exp");
  });

  it("degrades to an informational note when no token is available to inspect", async () => {
    const r = await authMaxAgeCheck({ tokenTtlSeconds: DAY }, undefined, () => iat).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.notes?.join(" ")).toMatch(/age/i);
    expect(r.details?.tokenTtlSeconds).toBe(String(DAY));
  });
});

describe("THE-521 obsidian detection check", () => {
  it("summarises detected vaults and local-rest-api presence", async () => {
    const p = profile({
      obsidian: {
        registryPath: "/r",
        installed: true,
        vaults: [
          {
            id: "v1",
            path: "/v1",
            name: "Brain",
            open: true,
            source: "registry",
            configDir: { name: ".obsidian", path: "/v1/.obsidian", overridden: false },
            plugins: {
              installed: [
                {
                  id: "obsidian-local-rest-api",
                  name: "REST",
                  version: "4.1.7",
                  minAppVersion: "",
                  author: "",
                  description: "",
                  isDesktopOnly: false,
                  folderIdMismatch: false,
                  enabled: true,
                },
              ],
              unreadable: [],
            },
          },
        ],
      },
    });
    const r = await obsidianCheck(p).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.vaults).toBe("1");
    expect(r.summary.toLowerCase()).toContain("brain");
  });

  it("notes when no Obsidian install was detected (not a failure)", async () => {
    const p = profile({ obsidian: { registryPath: null, installed: false, vaults: [] } });
    const r = await obsidianCheck(p).run(ctx);
    expect(r.status).toBe("ok"); // headless is a supported state
    expect(r.notes?.join(" ").toLowerCase()).toContain("no obsidian");
  });
});

describe("THE-523 bridge.state doctor check", () => {
  it("is ok when every vault is live or headless", async () => {
    const { bridgeCheck } = await import("../src/doctor/checks");
    const r = await bridgeCheck([
      { vaultId: "a", report: { state: "live", reason: "companion-reachable" } },
      { vaultId: "b", report: { state: "headless", reason: "companion-missing" } },
    ]).run({ serverVersion: "1.10.0" });
    expect(r.status).toBe("ok");
    expect(r.details?.a).toContain("live");
    expect(r.details?.b).toContain("headless");
  });

  it("warns and surfaces remediation when a vault is degraded (version skew or unreachable)", async () => {
    const { bridgeCheck } = await import("../src/doctor/checks");
    const r = await bridgeCheck([
      {
        vaultId: "a",
        report: {
          state: "degraded",
          reason: "enabled-but-unreachable",
          remediation: "reload the plugin inside Obsidian",
        },
      },
    ]).run({ serverVersion: "1.10.0" });
    expect(r.status).toBe("warning");
    expect(r.summary.toLowerCase()).toContain("degraded");
    expect(r.remediation).toMatch(/reload/i);
  });

  it("is ok with no vaults configured", async () => {
    const { bridgeCheck } = await import("../src/doctor/checks");
    const r = await bridgeCheck([]).run({ serverVersion: "1.10.0" });
    expect(r.status).toBe("ok");
  });
});

describe("#16 retrievalHeadsCheck (dense/sparse/ColBERT/reranker readiness)", () => {
  const view = (over: Partial<RetrievalHeadsView> = {}): RetrievalHeadsView => ({
    denseProvider: "ollama",
    denseModel: "nomic-embed-text",
    denseDimensions: 768,
    multiVector: false,
    sparseEnabled: false,
    colbertEnabled: false,
    ...over,
  });

  it("dense-only provider with streams off: ok, dense ready, sparse/ColBERT off", async () => {
    const r = await retrievalHeadsCheck(view()).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.dense).toContain("ready");
    expect(r.details?.sparse).toContain("off");
    expect(r.details?.colbert).toContain("off");
    // no model-tier reranker on a dense-only provider
    expect(r.details?.reranker).toContain("RRF-only");
  });

  it("warns when a stream is enabled but the provider emits no multi-vector head (inert)", async () => {
    const r = await retrievalHeadsCheck(view({ sparseEnabled: true, colbertEnabled: true })).run(
      ctx,
    );
    expect(r.status).toBe("warning");
    expect(r.details?.sparse).toContain("INERT");
    expect(r.details?.colbert).toContain("INERT");
    expect(r.issues?.length).toBe(2);
    expect(r.remediation).toContain("bge-m3");
  });

  it("multi-vector provider with streams on: all heads ready, ok", async () => {
    const r = await retrievalHeadsCheck(
      view({
        denseProvider: "bge-m3",
        multiVector: true,
        sparseEnabled: true,
        colbertEnabled: true,
      }),
    ).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.sparse).toContain("ready");
    expect(r.details?.colbert).toContain("ready");
    expect(r.details?.reranker).toContain("rerank capable");
  });
});
