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
const gitComposePath = join(repoRoot, "deploy/compose.git.yml");
const mcpoComposePath = join(repoRoot, "deploy/compose.mcpo.yml");

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

describe("git-backed Docker deployment (-git image)", () => {
  it("pins the -git image, guards the git URL and SSH key, and never mounts a key file", () => {
    const compose = parse(readFileSync(gitComposePath, "utf8")) as {
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
    expect(service?.image).toBe("ghcr.io/the-40-thieves/obsidian-tc:latest-git");
    expect(service?.restart).toBe("unless-stopped");
    expect(service?.volumes).toContain("obsidian-tc-data:/data");
    expect(service?.volumes).toContain("./config:/config:ro");
    expect(service?.volumes?.some((volume) => /key|known_hosts|ssh/i.test(volume))).toBe(false);
    expect(service?.environment?.OBSIDIAN_TC_VAULT_GIT_URL).toMatch(
      /^\$\{OBSIDIAN_TC_VAULT_GIT_URL:\?/,
    );
    expect(service?.environment?.OBSIDIAN_TC_VAULT_GIT_SSH_KEY).toMatch(
      /^\$\{OBSIDIAN_TC_VAULT_GIT_SSH_KEY:\?/,
    );
    expect(service?.environment?.OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET).toBe(
      ["$", "{OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET:-}"].join(""),
    );
    expect(service?.environment?.OBSIDIAN_TC_PUBLIC_URL).toMatch(/^\$\{OBSIDIAN_TC_PUBLIC_URL:\?/);
    expect(service?.environment?.OBSIDIAN_TC_JWT_SECRET).toMatch(/^\$\{OBSIDIAN_TC_JWT_SECRET:\?/);
    expect(compose.volumes).toHaveProperty("obsidian-tc-data");
  });
});

describe("OpenAPI bridge overlay (mcpo)", () => {
  it("runs the pinned mcpo bridge against the essentials surface, fail-closed and loopback-only", () => {
    const compose = parse(readFileSync(mcpoComposePath, "utf8")) as {
      services?: Record<
        string,
        {
          image?: string;
          restart?: string;
          command?: string[];
          ports?: string[];
          depends_on?: Record<string, { condition?: string }>;
          environment?: Record<string, string>;
        }
      >;
    };
    const bridge = compose.services?.mcpo;
    expect(bridge?.image).toMatch(
      /^ghcr\.io\/open-webui\/mcpo:git-[0-9a-f]{7}@sha256:[0-9a-f]{64}$/,
    );
    expect(bridge?.restart).toBe("unless-stopped");
    expect(bridge?.depends_on?.["obsidian-tc"]?.condition).toBe("service_healthy");
    expect(bridge?.ports).toEqual(["127.0.0.1:$" + "{MCPO_PORT:-8000}:8000"]);

    const command = bridge?.command ?? [];
    expect(command).toContain("--strict-auth");
    expect(command).toContain("--server-type");
    expect(command[command.indexOf("--server-type") + 1]).toBe("streamable-http");
    expect(command.join(" ")).toMatch(/--api-key \$\{OBSIDIAN_TC_MCPO_API_KEY:\?/);
    expect(command.join(" ")).toMatch(/Bearer \$\{OBSIDIAN_TC_MCPO_TOKEN:\?/);
    expect(command.join(" ")).not.toContain("client_header_forwarding");
    expect(command.at(-1)).toBe("http://obsidian-tc:$" + "{PORT:-8765}/mcp/essentials");

    const server = compose.services?.["obsidian-tc"];
    expect(server?.environment?.OBSIDIAN_TC_ALLOWED_HOSTS).toBe("obsidian-tc");
  });

  it("admits the compose-internal Host header through the real loader", () => {
    const dir = makeTempDir("obtc-deploy-mcpo-");
    try {
      vi.stubEnv("PORT", "8765");
      vi.stubEnv("OBSIDIAN_TC_PUBLIC_URL", "https://vault.example.com");
      vi.stubEnv("OBSIDIAN_TC_JWT_SECRET", "deploy-smoke-secret-that-is-at-least-32-chars");
      vi.stubEnv("OBSIDIAN_TC_VAULT_PATH", join(dir, "vault"));
      vi.stubEnv("OBSIDIAN_TC_CACHE_DIR", join(dir, "cache"));
      vi.stubEnv("OBSIDIAN_TC_ALLOWED_HOSTS", "obsidian-tc");

      const config = loadConfig(configPath);

      expect(config.transports.http.allowedHosts).toContain("obsidian-tc");
    } finally {
      rmTemp(dir);
    }
  });
});
