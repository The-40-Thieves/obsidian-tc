import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config/load";
import { makeTempDir, rmTemp } from "./tmp";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const configPath = join(repoRoot, "deploy/config/obsidian-tc.config.json");
const composePath = join(repoRoot, "deploy/compose.http.yml");

afterEach(() => vi.unstubAllEnvs());

describe("shared HTTP Docker deployment", () => {
  it("loads the shipped config through the real loader with compose environment overlays", () => {
    const dir = makeTempDir("obtc-deploy-config-");
    const vault = join(dir, "vault");
    const cache = join(dir, "cache");
    mkdirSync(vault);
    try {
      vi.stubEnv("PORT", "8765");
      vi.stubEnv("OBSIDIAN_TC_PUBLIC_URL", "https://vault.example.com");
      vi.stubEnv("OBSIDIAN_TC_JWT_SECRET", "deploy-smoke-secret-that-is-at-least-32-chars");
      vi.stubEnv("OBSIDIAN_TC_VAULT_PATH", vault);
      vi.stubEnv("OBSIDIAN_TC_CACHE_DIR", cache);

      const config = loadConfig(configPath);

      expect(config.transports.http).toMatchObject({ enabled: true, host: "0.0.0.0", port: 8765 });
      expect(config.transports.stdio).toBe(false);
      expect(config.auth.mode).toBe("jwt");
      expect(config.auth.resource).toBe("https://vault.example.com/mcp");
      expect(config.auth.requireJti).toBe(true);
      expect(config.transports.http.allowedHosts).toContain("vault.example.com");
      expect(config.vaults).toHaveLength(1);
      expect(config.vaults[0]).toMatchObject({ id: "main", path: vault });
      expect(config.cacheDir).toBe(cache);
    } finally {
      rmTemp(dir);
    }
  });

  it("pins the published image, named data volume, directory config mount, and restart policy", () => {
    const compose = parse(readFileSync(composePath, "utf8")) as {
      services?: Record<
        string,
        {
          image?: string;
          restart?: string;
          volumes?: string[];
          environment?: Record<string, string>;
        }
      >;
      volumes?: Record<string, unknown>;
    };
    const service = compose.services?.["obsidian-tc"];
    expect(service?.image).toBe("ghcr.io/the-40-thieves/obsidian-tc:latest");
    expect(service?.restart).toBe("unless-stopped");
    expect(service?.volumes).toContain("obsidian-tc-data:/data");
    expect(service?.volumes).toContain("./config:/config:ro");
    expect(service?.environment?.OBSIDIAN_TC_CONFIG).toBe("/config/obsidian-tc.config.json");
    expect(service?.environment?.OBSIDIAN_TC_PUBLIC_URL).toMatch(/^\$\{OBSIDIAN_TC_PUBLIC_URL:\?/);
    expect(service?.environment?.OBSIDIAN_TC_JWT_SECRET).toMatch(/^\$\{OBSIDIAN_TC_JWT_SECRET:\?/);
    expect(service?.environment?.PORT).toBe(["$", "{PORT:-8765}"].join(""));
    expect(compose.volumes).toHaveProperty("obsidian-tc-data");
  });

  it("refuses the remote JWT config when OBSIDIAN_TC_PUBLIC_URL is absent", () => {
    const dir = makeTempDir("obtc-deploy-no-public-url-");
    try {
      vi.stubEnv("PORT", "8765");
      vi.stubEnv("OBSIDIAN_TC_PUBLIC_URL", "");
      vi.stubEnv("OBSIDIAN_TC_JWT_SECRET", "deploy-smoke-secret-that-is-at-least-32-chars");
      vi.stubEnv("OBSIDIAN_TC_VAULT_PATH", join(dir, "vault"));
      vi.stubEnv("OBSIDIAN_TC_CACHE_DIR", join(dir, "cache"));

      expect(() => loadConfig(configPath)).toThrow(/non-loopback jwt server without an audience/);
    } finally {
      rmTemp(dir);
    }
  });
});
