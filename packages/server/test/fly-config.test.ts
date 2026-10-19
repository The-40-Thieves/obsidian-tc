// The repo-root fly.toml Fly app config. `fly launch --from` reads it from the clone, and a misspelled
// key is ignored, so these assertions pin the fields the Fly.io deployment page names. The file is
// parsed by Bun's TOML parser through the shared CLI runner, so no TOML dependency is added.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/load";
import { isHostAllowed } from "../src/transports/host-guard";
import { runBunSync } from "./spawn-cli";
import { makeTempDir, rmTemp } from "./tmp";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const flyPath = join(repoRoot, "fly.toml");

interface FlyCheck {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}

interface FlyConfig {
  build?: { image?: string };
  env?: Record<string, string>;
  files?: { guest_path?: string; local_path?: string }[];
  mounts?: { source?: string; destination?: string; initial_size?: string };
  http_service?: {
    internal_port?: number;
    auto_stop_machines?: string;
    min_machines_running?: number;
    checks?: FlyCheck[];
  };
  vm?: { size?: string; memory?: string }[];
}

const parseFly = (): FlyConfig => {
  const run = runBunSync(
    [
      "-e",
      "process.stdout.write(JSON.stringify(Bun.TOML.parse(await Bun.file(process.env.FLY_TOML).text())))",
    ],
    { env: { FLY_TOML: flyPath } },
  );
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as FlyConfig;
};

const fly = parseFly();
const env = fly.env ?? {};

afterEach(() => vi.unstubAllEnvs());

describe("fly.toml", () => {
  it("runs the published image, not a build of the repository Dockerfile", () => {
    expect(fly.build?.image).toBe("ghcr.io/the-40-thieves/obsidian-tc:latest");
  });

  it("mounts one volume at /data, as a single table", () => {
    expect(Array.isArray(fly.mounts)).toBe(false);
    expect(fly.mounts?.destination).toBe("/data");
    expect(fly.mounts?.source).toBeTruthy();
    expect(fly.mounts?.initial_size).toBeTruthy();
  });

  it("serves the port the server reads from PORT", () => {
    expect(fly.http_service?.internal_port).toBe(Number(env.PORT));
    expect(fly.http_service?.internal_port).toBe(8765);
  });

  it("keeps one Machine running: the proxy never stops it", () => {
    expect(fly.http_service?.auto_stop_machines).toBe("off");
    expect(fly.http_service?.min_machines_running).toBe(1);
  });

  it("checks the unauthenticated liveness route with a loopback Host header", () => {
    const checks = fly.http_service?.checks ?? [];
    expect(checks).toHaveLength(1);
    expect(checks[0]?.path).toBe("/healthz");
    expect(checks[0]?.method).toBe("GET");
    expect(checks[0]?.headers?.Host).toBe("localhost");
  });

  it("copies the shared HTTP config to the path OBSIDIAN_TC_CONFIG names, from the repo", () => {
    const file = fly.files?.[0];
    expect(file?.guest_path).toBe(env.OBSIDIAN_TC_CONFIG);
    expect(file?.local_path).toBe("deploy/config/obsidian-tc.config.json");
    const shared = readFileSync(join(repoRoot, file?.local_path ?? ""), "utf8");
    expect(shared).toBe(
      readFileSync(join(repoRoot, "deploy/config/obsidian-tc.config.json"), "utf8"),
    );
  });

  it("keeps secrets and the public URL out of [env]", () => {
    for (const key of [
      "OBSIDIAN_TC_JWT_SECRET",
      "OBSIDIAN_TC_AS_SETUP_TOKEN",
      "OPENAI_API_KEY",
      "OBSIDIAN_TC_PUBLIC_URL",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.OBSIDIAN_TC_VAULT_PATH?.startsWith("/data/")).toBe(true);
    expect(env.OBSIDIAN_TC_CACHE_DIR?.startsWith("/data/")).toBe(true);
  });

  it("loads through the real config loader, and the check's Host header passes the guard", () => {
    const dir = makeTempDir("obtc-fly-config-");
    try {
      vi.stubEnv("PORT", env.PORT ?? "");
      vi.stubEnv("OBSIDIAN_TC_PUBLIC_URL", "https://obsidian-tc.fly.dev");
      vi.stubEnv("OBSIDIAN_TC_JWT_SECRET", "fly-smoke-secret-that-is-at-least-32-chars-long");
      vi.stubEnv("OBSIDIAN_TC_VAULT_PATH", join(dir, "vault"));
      vi.stubEnv("OBSIDIAN_TC_CACHE_DIR", join(dir, "cache"));
      mkdirSync(join(dir, "vault"));

      const config = loadConfig(join(repoRoot, "deploy/config/obsidian-tc.config.json"));

      expect(config.transports.http).toMatchObject({ enabled: true, host: "0.0.0.0", port: 8765 });
      const allowed = config.transports.http.allowedHosts ?? [];
      expect(allowed).toContain("obsidian-tc.fly.dev");
      expect(isHostAllowed("localhost", allowed)).toBe(true);
      expect(isHostAllowed("[fdaa::3]:8765", allowed)).toBe(false);
    } finally {
      rmTemp(dir);
    }
  });
});
