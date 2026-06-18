import { ServerConfigSchema } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { initOtel } from "../src/otel/tracing";

/** Build a real parsed observability config with an optional otel endpoint. */
function obs(endpoint?: string) {
  return ServerConfigSchema.parse({
    vaults: [{ id: "m", path: "/v" }],
    observability: endpoint ? { otel: { endpoint } } : {},
  }).observability;
}

describe("initOtel (G2.4 OTEL, conditional)", () => {
  it("is a no-op when no endpoint is configured (production default off)", async () => {
    const h = initOtel(obs(undefined), "1.0.0");
    expect(h.enabled).toBe(false);
    expect(h.tracer).toBeUndefined();
    await expect(h.shutdown()).resolves.toBeUndefined();
  });

  it("enables a tracer when an OTLP endpoint is configured", async () => {
    const h = initOtel(obs("http://localhost:4318/v1/traces"), "1.0.0");
    try {
      expect(h.enabled).toBe(true);
      expect(h.tracer).toBeDefined();
    } finally {
      await h.shutdown();
    }
  });
});
