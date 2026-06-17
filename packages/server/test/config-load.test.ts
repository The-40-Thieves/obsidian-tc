import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otc-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
});
