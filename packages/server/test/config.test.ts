import { describe, it, expect } from "vitest";
import { ServerConfigSchema } from "@obsidian-tc/shared";

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
    expect(ServerConfigSchema.safeParse({ vaults: [{ id: "m", path: "/v" }], auth: { mode: "jwt" } }).success).toBe(false);
    const ok = ServerConfigSchema.safeParse({ vaults: [{ id: "m", path: "/v" }], auth: { mode: "jwt", jwtSecret: "x".repeat(32) } });
    expect(ok.success).toBe(true);
  });
});
