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
  experientialEvaluatorCheck,
  nativeCheck,
  notesFtsIntegrityCheck,
  obsidianCheck,
  providerRegistrationCheck,
  runtimeCheck,
  snapshotsCheck,
} from "../src/doctor/checks";
import { type RetrievalHeadsView, retrievalHeadsCheck } from "../src/doctor/retrieval-heads";

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

  it("dense-only provider with streams off: ok, dense CONFIGURED (never 'ready'), sparse/ColBERT off", async () => {
    const r = await retrievalHeadsCheck(view()).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.dense).toContain("configured");
    // THE-688: the negative half is the point of this assertion. Every field on the view is
    // config-derived and this check never probes, so claiming readiness is a claim it cannot
    // support — a removed provider read as `dense: ready (ollama, ...)` for two days while every
    // semantic query failed. Regressing the wording must fail here, not in production.
    expect(r.details?.dense).not.toMatch(/\bready\b/);
    expect(r.summary).not.toMatch(/\bready\b/);
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

  it("multi-vector provider with streams on: all heads CONFIGURED (never 'ready'), ok", async () => {
    const r = await retrievalHeadsCheck(
      view({
        denseProvider: "bge-m3",
        multiVector: true,
        sparseEnabled: true,
        colbertEnabled: true,
      }),
    ).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.sparse).toContain("configured");
    expect(r.details?.colbert).toContain("configured");
    // THE-688: `multiVector` is inferred from the PROVIDER NAME, not observed, so these streams
    // are no better attested than the dense line. Leaving them as `ready` beside a dense line
    // saying `configured` would read as the stronger claim being the more trustworthy one.
    expect(r.details?.sparse).not.toMatch(/\bready\b/);
    expect(r.details?.colbert).not.toMatch(/\bready\b/);
    expect(r.details?.reranker).toContain("rerank capable");
  });
});

// Final-review blocker 2: embeddings.provider/reranker.provider are open strings resolved against
// the registry at boot — an unregistered name parses cleanly (ServerConfigSchema no longer rejects
// it) and is otherwise only caught by the server's own boot path. This check is doctor's catch.
describe("providers.registered check (final-review blocker 2)", () => {
  const REGISTERED = {
    embeddings: ["ollama", "openai", "openai-compatible"],
    reranker: ["gateway", "model-tier"],
  };

  it("ok when embeddings.provider is registered and no reranker is configured", async () => {
    const r = await providerRegistrationCheck({ embeddingsProvider: "ollama" }, REGISTERED).run(
      ctx,
    );
    expect(r.status).toBe("ok");
    expect(r.details?.embeddings).toBe("ollama");
    expect(r.details?.reranker).toBeUndefined();
  });

  it("ok when the configured reranker is also registered", async () => {
    const r = await providerRegistrationCheck(
      { embeddingsProvider: "openai", rerankerProvider: "gateway" },
      REGISTERED,
    ).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.reranker).toBe("gateway");
  });

  it("fails and lists every registered name when embeddings.provider is unregistered", async () => {
    const r = await providerRegistrationCheck({ embeddingsProvider: "ollma" }, REGISTERED).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.details?.embeddings).toContain("UNREGISTERED");
    expect(r.issues?.join(" ")).toContain('embeddings.provider "ollma"');
    for (const name of REGISTERED.embeddings) expect(r.issues?.join(" ")).toContain(name);
  });

  it("fails when reranker.provider is configured but unregistered", async () => {
    const r = await providerRegistrationCheck(
      { embeddingsProvider: "ollama", rerankerProvider: "no-such-reranker" },
      REGISTERED,
    ).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.details?.reranker).toContain("UNREGISTERED");
    expect(r.issues?.join(" ")).toContain('reranker.provider "no-such-reranker"');
    for (const name of REGISTERED.reranker) expect(r.issues?.join(" ")).toContain(name);
  });

  it("reports both issues when both provider names are unregistered", async () => {
    const r = await providerRegistrationCheck(
      { embeddingsProvider: "ollma", rerankerProvider: "no-such-reranker" },
      REGISTERED,
    ).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.issues?.length).toBe(2);
  });
});

describe("THE-648 snapshots.policy check", () => {
  it("reports ok with the retention count when snapshots are enabled (the default)", async () => {
    const r = await snapshotsCheck({ enabled: true, retention: 10 }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.enabled).toBe("true");
    expect(r.summary).toContain("10");
  });

  it("warns when snapshots are explicitly disabled, with remediation", async () => {
    const r = await snapshotsCheck({ enabled: false, retention: 10 }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary.toLowerCase()).toContain("no built-in rollback");
    expect(r.remediation).toBeTruthy();
  });
});

// THE-696 — the same configured-vs-VERIFIED split THE-688 drew for the embeddings provider, applied
// to notes_fts. health.fts_enabled answers "is FTS5 available on this connection", which stayed
// `true` throughout the period the live index was malformed and silently serving partial answers.
describe("THE-696 search.notes_fts check", () => {
  it("does NOT claim soundness when no probe was supplied", async () => {
    const r = await notesFtsIntegrityCheck({ ftsEnabled: true }).run(ctx);
    expect(r.status).toBe("ok");
    // The wording is the point. "provisioned" is what the default run can support; anything
    // stronger is the THE-688 `dense: ready` literal wearing a different name.
    expect(r.details?.notes_fts).toContain("not verified");
    expect(r.details?.notes_fts).not.toContain("SOUND");
  });

  it("reports SOUND only when a probe actually looked", async () => {
    const r = await notesFtsIntegrityCheck({
      ftsEnabled: true,
      probe: () => ({ ok: true }),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.notes_fts).toContain("SOUND");
  });

  it("warns with SQLite's own reason when the probe finds a malformed index", async () => {
    const r = await notesFtsIntegrityCheck({
      ftsEnabled: true,
      probe: () => ({ ok: false, reason: "database disk image is malformed" }),
    }).run(ctx);
    // A warning, not a fail: the server still boots and chunk-level retrieval is unaffected —
    // what degrades is the note-level lexical surface (search_text, find_notes_by_*, list_tags).
    expect(r.status).toBe("warning");
    expect(r.details?.notes_fts).toContain("MALFORMED");
    expect(r.issues?.join(" ")).toContain("database disk image is malformed");
    expect(r.remediation).toBeTruthy();
  });

  it("reports FTS as off rather than unsound when FTS5 is unavailable", async () => {
    // OBSIDIAN_TC_DISABLE_FTS=1 or an adapter built without FTS5 is a supported configuration —
    // the query layer falls back to disk scans. Calling that "malformed" would be a false alarm.
    const r = await notesFtsIntegrityCheck({ ftsEnabled: false }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.notes_fts).toContain("off");
    expect(r.issues).toBeUndefined();
  });
});

// THE-698 — the same class of signal THE-696 needed for notes_fts, applied to the experiential
// tier, as the ticket asks ("consider one mechanism rather than two"). Nothing reported that 337 of
// 337 episodes were pending for seventeen days; work_search just returned empty, which is
// indistinguishable from "nothing matched".
describe("THE-698 experiential.evaluator check", () => {
  it("reports off when the experiential store is closed", async () => {
    const r = await experientialEvaluatorCheck({ enabled: false }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.evaluator).toContain("off");
    expect(r.issues).toBeUndefined();
  });

  it("does NOT claim a backlog is healthy when no probe counted it", async () => {
    const r = await experientialEvaluatorCheck({ enabled: true }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.evaluator).toContain("not counted");
  });

  it("is ok when the probe finds no pending backlog", async () => {
    const r = await experientialEvaluatorCheck({
      enabled: true,
      probe: () => ({ pending: 0, eligible: 412, promotable: 0, oldestPromotableAgeMs: null }),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.evaluator).toContain("0 pending");
  });

  it("is ok for a fresh backlog — pending is a transient state by design", async () => {
    // Episodes captured since the last tick are SUPPOSED to be pending. Warning on any non-zero
    // count would make the check cry wolf on every healthy deployment.
    const r = await experientialEvaluatorCheck({
      enabled: true,
      probe: () => ({ pending: 6, eligible: 412, promotable: 6, oldestPromotableAgeMs: 60_000 }),
    }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("warns when the oldest pending episode has outlived any plausible tick", async () => {
    const r = await experientialEvaluatorCheck({
      enabled: true,
      probe: () => ({
        pending: 337,
        eligible: 0,
        promotable: 333,
        oldestPromotableAgeMs: 17 * 86_400_000,
      }),
    }).run(ctx);
    // The exact live condition: 337 pending, zero eligible, 17 days old.
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("work_search");
    expect(r.remediation).toBeTruthy();
  });

  it("stays ok when every remaining pending row is HELD for cause — the live post-promotion state", async () => {
    // The regression this exact check shipped with and had to be corrected for. After the live
    // promotion the store held 333 eligible and 4 contradictory index_vault episodes that the
    // deterministic rules hold FOREVER. Keyed on `pending` the check warned about its own success;
    // keyed on `promotable` it is correctly quiet.
    const r = await experientialEvaluatorCheck({
      enabled: true,
      probe: () => ({
        pending: 4,
        eligible: 333,
        promotable: 0,
        oldestPromotableAgeMs: null,
      }),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.evaluator).toContain("held for cause");
    expect(r.issues).toBeUndefined();
  });
});
