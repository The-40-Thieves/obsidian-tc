import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlaneEnabledExplicit, loadConfig } from "../src/config/load";
import { rmTemp } from "./tmp";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otc-cfg-"));
});
afterEach(() => {
  rmTemp(dir);
  process.env.OBSIDIAN_TC_JWT_SECRET = "";
});

function writeConfig(obj: unknown): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

describe("loadConfig", () => {
  it("parses a minimal config and applies schema defaults", () => {
    const cfg = loadConfig(writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }] }));
    expect(cfg.vaults[0]?.id).toBe("v1");
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.transports.stdio).toBe(true);
    expect(cfg.governor.maxResponseBytes).toBe(1_000_000);
  });

  it("overlays the JWT secret from the environment", () => {
    process.env.OBSIDIAN_TC_JWT_SECRET = "x".repeat(40);
    const cfg = loadConfig(
      writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: { mode: "jwt" } }),
    );
    expect(cfg.auth.mode).toBe("jwt");
    expect((cfg.auth as { jwtSecret?: string }).jwtSecret).toHaveLength(40);
  });

  it("rejects an invalid config", () => {
    expect(() => loadConfig(writeConfig({ vaults: [] }))).toThrow();
  });

  it("strips a leading UTF-8 BOM before parsing (THE-185)", () => {
    const p = join(dir, "bom.json");
    writeFileSync(
      p,
      `\uFEFF${JSON.stringify({ vaults: [{ id: "v1", path: "/tmp/v1" }] })}`,
      "utf8",
    );
    expect(loadConfig(p).vaults[0]?.id).toBe("v1");
  });
});

// THE-825: `isPlaneEnabledExplicit` is the signal that distinguishes "the raw config never
// mentioned plane.enabled" (defaulted) from "the raw config set plane.enabled: false on purpose"
// (deliberate opt-out) -- the two are indistinguishable once ServerConfigSchema.parse has run.
describe("isPlaneEnabledExplicit (THE-825)", () => {
  it("false when the raw config has no plane block at all", () => {
    expect(isPlaneEnabledExplicit({ vaults: [] })).toBe(false);
  });

  it("false when plane is present but enabled is not", () => {
    expect(isPlaneEnabledExplicit({ plane: { intervalMinutes: 120 } })).toBe(false);
  });

  it("true when the raw config explicitly set plane.enabled: false", () => {
    expect(isPlaneEnabledExplicit({ plane: { enabled: false } })).toBe(true);
  });

  it("true when the raw config explicitly set plane.enabled: true", () => {
    expect(isPlaneEnabledExplicit({ plane: { enabled: true } })).toBe(true);
  });

  it("false when plane is present but not an object (malformed, schema will reject it later)", () => {
    expect(isPlaneEnabledExplicit({ plane: "nope" })).toBe(false);
    expect(isPlaneEnabledExplicit({ plane: null })).toBe(false);
    expect(isPlaneEnabledExplicit({ plane: ["enabled"] })).toBe(false);
  });
});
