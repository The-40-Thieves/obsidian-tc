import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

describe("config schema", () => {
  it("applies defaults from a minimal config", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/v" }] });
    expect(c.auth.mode).toBe("none");
    expect(c.embeddings.provider).toBe("ollama");
    expect(c.transports.stdio).toBe(true);
    expect(c.governor.maxResponseBytes).toBe(1_000_000);
  });

  it("applies the G2.4 throttle tier defaults (M6 back-compat)", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/v" }] });
    expect(c.throttle.enabled).toBe(true);
    expect(c.throttle.tiers.bulk).toEqual({ perMinute: 10, burst: 3 });
    expect(c.throttle.tiers.read).toEqual({ perMinute: 600, burst: 100 });
    expect(c.throttle.maxConcurrentWritesPerVault).toBe(16);
  });

  it("accepts a throttle override and fills the rest from defaults", () => {
    const c = ServerConfigSchema.parse({
      vaults: [{ id: "m", path: "/v" }],
      throttle: { tiers: { bulk: { perMinute: 5, burst: 2 } } },
    });
    expect(c.throttle.tiers.bulk).toEqual({ perMinute: 5, burst: 2 });
    expect(c.throttle.tiers.write).toEqual({ perMinute: 60, burst: 20 });
  });

  it("applies observability defaults (export streams off/local by default, M7)", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/v" }] });
    // traceDetail / tracesSampleRate used to be asserted here. They were removed from the schema: no
    // sampling was ever applied and no detail switch existed, so they promised behavior the code does
    // not implement. A test asserting a default for a key nothing reads only locks the lie in place.
    // OTEL is a no-op until an endpoint is set.
    expect(c.observability.otel.endpoint).toBeUndefined();
    expect(c.observability.otel.headers).toEqual({});
    // /metrics endpoint disabled by default; bind localhost only.
    expect(c.observability.prometheus).toEqual({ enabled: false, port: 9464, bind: "127.0.0.1" });
    // MORGIANA JSONL spool on by default; HTTP push off.
    expect(c.observability.morgiana.spool).toBe(true);
    expect(c.observability.morgiana.httpEndpoint).toBeUndefined();
    expect(c.observability.morgiana.httpHeaders).toEqual({});
    // Retention prunes event_log and nothing else. morgianaEventsDays / tracesDays were declared and
    // read by nothing — morgiana spools and trace files grew without bound whatever they were set to —
    // so they are gone. This assertion is now exhaustive on purpose: it fails if a key is re-added
    // without the code that honors it.
    expect(c.observability.retention).toEqual({ eventLogDays: 30 });
  });

  it("accepts the full G2.4 observability shape and fills inner gaps", () => {
    const c = ServerConfigSchema.parse({
      vaults: [{ id: "m", path: "/v" }],
      observability: {
        // Deliberately still passing the two REMOVED keys. This is the back-compat claim under test:
        // the schema is not .strict(), so an existing operator config that still carries them must
        // keep validating, with the keys simply ignored. Asserting it beats claiming it.
        traceDetail: "verbose",
        tracesSampleRate: 0.5,
        otel: { endpoint: "http://localhost:4318", headers: { Authorization: "Bearer x" } },
        prometheus: { enabled: true, port: 9999, bind: "0.0.0.0" },
        morgiana: { spool: false, httpEndpoint: "https://morgiana.internal/events" },
        retention: { eventLogDays: 7 },
      },
    });
    // The removed keys parsed without error and were dropped — an old config still boots.
    expect((c.observability as Record<string, unknown>).traceDetail).toBeUndefined();
    expect((c.observability as Record<string, unknown>).tracesSampleRate).toBeUndefined();
    expect(c.observability.otel.endpoint).toBe("http://localhost:4318");
    expect(c.observability.otel.headers).toEqual({ Authorization: "Bearer x" });
    expect(c.observability.prometheus).toEqual({ enabled: true, port: 9999, bind: "0.0.0.0" });
    expect(c.observability.morgiana.spool).toBe(false);
    expect(c.observability.morgiana.httpEndpoint).toBe("https://morgiana.internal/events");
    expect(c.observability.retention.eventLogDays).toBe(7);
  });

  it("requires at least one vault", () => {
    expect(ServerConfigSchema.safeParse({ vaults: [] }).success).toBe(false);
  });
  it("rejects jwt mode without a secret and accepts it with one", () => {
    expect(
      ServerConfigSchema.safeParse({ vaults: [{ id: "m", path: "/v" }], auth: { mode: "jwt" } })
        .success,
    ).toBe(false);
    const ok = ServerConfigSchema.safeParse({
      vaults: [{ id: "m", path: "/v" }],
      auth: { mode: "jwt", jwtSecret: "x".repeat(32) },
    });
    expect(ok.success).toBe(true);
  });

  it("leaves per-vault bridge/plugin config undefined when omitted (M4 back-compat)", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "m", path: "/v" }] });
    expect(c.vaults[0]?.bridges).toBeUndefined();
    expect(c.vaults[0]?.plugins).toBeUndefined();
  });

  it("fills inner bridge/plugin defaults when the block is present", () => {
    const c = ServerConfigSchema.parse({
      vaults: [{ id: "m", path: "/v", bridges: {}, plugins: {} }],
    });
    expect(c.vaults[0]?.bridges?.timeoutMs).toBe(5000);
    expect(c.vaults[0]?.bridges?.probeTimeoutMs).toBe(500);
    expect(c.vaults[0]?.plugins?.probeSkip).toBe(false);
    expect(c.vaults[0]?.plugins?.forceEnabled).toEqual([]);
  });

  it("accepts explicit per-vault bridge + plugin overrides", () => {
    const c = ServerConfigSchema.parse({
      vaults: [
        {
          id: "m",
          path: "/v",
          restApiUrl: "http://127.0.0.1:27124",
          restApiKey: "k",
          bridges: { timeoutMs: 1000 },
          plugins: { forceEnabled: ["dataview"], probeSkip: true },
        },
      ],
    });
    expect(c.vaults[0]?.bridges?.timeoutMs).toBe(1000);
    expect(c.vaults[0]?.bridges?.probeTimeoutMs).toBe(500);
    expect(c.vaults[0]?.plugins?.forceEnabled).toEqual(["dataview"]);
    expect(c.vaults[0]?.plugins?.probeSkip).toBe(true);
  });
});

describe("maintenance config (THE-292)", () => {
  it("defaults: enabled hourly sweep; a pre-THE-292 config validates unchanged", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/v" }] });
    expect(c.maintenance).toEqual({ enabled: true, intervalMinutes: 60 });
  });

  it("partial override fills the rest from defaults", () => {
    const c = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      maintenance: { intervalMinutes: 5 },
    });
    expect(c.maintenance).toEqual({ enabled: true, intervalMinutes: 5 });
  });
});
