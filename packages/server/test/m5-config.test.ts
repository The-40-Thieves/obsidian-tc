// M5 config (THE-181): the global plur block + per-vault memory/workspace blocks.
// All three are additive and optional — a config predating M5 parses unchanged
// (the M4 back-compat invariant) — and the OBSIDIAN_TC_PLUR_* env vars overlay the
// endpoint/token the same way the JWT secret does, keeping the bearer off disk.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";

describe("M5 config schema", () => {
  it("leaves plur + per-vault memory/workspace undefined when omitted", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "m", path: "/v" }] });
    expect(c.plur).toBeUndefined();
    expect(c.vaults[0]?.memory).toBeUndefined();
    expect(c.vaults[0]?.workspace).toBeUndefined();
  });

  it("fills inner defaults when each block is present", () => {
    const c = ServerConfigSchema.parse({
      plur: {},
      vaults: [{ id: "m", path: "/v", memory: {}, workspace: {} }],
    });
    expect(c.plur?.endpoint).toBeUndefined();
    expect(c.plur?.apiPrefix).toBe("");
    expect(c.plur?.timeoutMs).toBe(5000);
    expect(c.vaults[0]?.memory?.folder).toBe("memory");
    expect(c.vaults[0]?.workspace?.traceFolder).toBe(".obsidian-tc/traces");
  });

  it("accepts explicit overrides", () => {
    const c = ServerConfigSchema.parse({
      plur: { endpoint: "http://127.0.0.1:7077", apiKey: "k", apiPrefix: "/v1", timeoutMs: 1000 },
      vaults: [
        {
          id: "m",
          path: "/v",
          memory: { folder: "Brain/Entities" },
          workspace: { traceFolder: "traces" },
        },
      ],
    });
    expect(c.plur?.endpoint).toBe("http://127.0.0.1:7077");
    expect(c.plur?.apiPrefix).toBe("/v1");
    expect(c.plur?.timeoutMs).toBe(1000);
    expect(c.vaults[0]?.memory?.folder).toBe("Brain/Entities");
    expect(c.vaults[0]?.workspace?.traceFolder).toBe("traces");
  });

  it("rejects a non-URL plur endpoint", () => {
    expect(
      ServerConfigSchema.safeParse({
        plur: { endpoint: "not a url" },
        vaults: [{ id: "m", path: "/v" }],
      }).success,
    ).toBe(false);
  });
});

describe("loadConfig plur env overlay", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otc-m5cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.OBSIDIAN_TC_PLUR_ENDPOINT = "";
    process.env.OBSIDIAN_TC_PLUR_TOKEN = "";
  });

  function writeConfig(obj: unknown): string {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  }

  it("overlays endpoint + token from the environment", () => {
    process.env.OBSIDIAN_TC_PLUR_ENDPOINT = "http://127.0.0.1:7077";
    process.env.OBSIDIAN_TC_PLUR_TOKEN = "secret-token";
    const cfg = loadConfig(writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }] }));
    expect(cfg.plur?.endpoint).toBe("http://127.0.0.1:7077");
    expect(cfg.plur?.apiKey).toBe("secret-token");
  });

  it("env endpoint overlays a file-provided plur block without dropping its other keys", () => {
    process.env.OBSIDIAN_TC_PLUR_ENDPOINT = "http://override:9000";
    const cfg = loadConfig(
      writeConfig({
        plur: { apiPrefix: "/v2", timeoutMs: 2000 },
        vaults: [{ id: "v1", path: "/tmp/v1" }],
      }),
    );
    expect(cfg.plur?.endpoint).toBe("http://override:9000");
    expect(cfg.plur?.apiPrefix).toBe("/v2");
    expect(cfg.plur?.timeoutMs).toBe(2000);
  });

  it("leaves plur undefined when neither config nor env supplies it", () => {
    const cfg = loadConfig(writeConfig({ vaults: [{ id: "v1", path: "/tmp/v1" }] }));
    expect(cfg.plur).toBeUndefined();
  });
});
