import { ServerConfigSchema } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";

describe("config schema", () => {
  it("applies defaults from a minimal config", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/v" }] });
    expect(c.auth.mode).toBe("none");
    expect(c.embeddings.provider).toBe("ollama");
    expect(c.transports.stdio).toBe(true);
    expect(c.governor.maxResponseBytes).toBe(1_000_000);
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
