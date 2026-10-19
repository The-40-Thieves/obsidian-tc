import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedHome } from "../scripts/lib/isolated-home.mjs";
import { ensureEnvVaultRoot } from "../src/vault/ensure-root";
import { runBunSync } from "./spawn-cli";
import { makeTempDir, rmTemp } from "./tmp";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const CREATED_LINE = "created the missing vault root";

const temps: string[] = [];
const homes: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const t of temps.splice(0)) rmTemp(t);
});

/** An empty data volume beside a config file, the shape a fresh Fly/Render/Railway mount has. */
function freshVolume(configBody: (data: string) => string): { config: string; data: string } {
  const root = makeTempDir("obtc-vaultroot-");
  temps.push(root);
  const data = join(root, "data");
  mkdirSync(data);
  const config = join(root, "config.json");
  writeFileSync(config, configBody(data));
  return { config, data };
}

function isolatedEnv(): Record<string, string> {
  const iso = createIsolatedHome("obtc-vaultroot-iso-");
  homes.push(iso);
  return iso.env;
}

describe("first boot on an empty data volume", () => {
  it("creates the env vault root on an empty data volume and boots", () => {
    const { config, data } = freshVolume(() => "{}");
    const vault = join(data, "vault");
    const run = runBunSync(["src/cli.ts"], {
      cwd: PACKAGE_ROOT,
      env: {
        ...isolatedEnv(),
        OBSIDIAN_TC_CONFIG: config,
        OBSIDIAN_TC_VAULT_PATH: vault,
        OBSIDIAN_TC_CACHE_DIR: join(data, "cache"),
      },
    });
    expect(run.stderr).toContain("ready on stdio");
    expect(run.stderr.split(CREATED_LINE).length - 1).toBe(1);
    expect(statSync(vault).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(vault).uid).toBe(process.getuid?.());
    expect(run.code).toBe(0);
  });

  it("a config-file vault path that is missing still exits and creates nothing", () => {
    const { config, data } = freshVolume((dir) =>
      JSON.stringify({ vaults: [{ id: "main", path: join(dir, "vualt") }] }),
    );
    const typo = join(data, "vualt");
    const run = runBunSync(["src/cli.ts"], {
      cwd: PACKAGE_ROOT,
      env: {
        ...isolatedEnv(),
        OBSIDIAN_TC_CONFIG: config,
        OBSIDIAN_TC_VAULT_PATH: "",
        OBSIDIAN_TC_CACHE_DIR: join(data, "cache"),
      },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("fatal: vault root could not be resolved");
    expect(run.stderr).not.toContain(CREATED_LINE);
    expect(() => statSync(typo)).toThrow();
  });
});

describe("ensureEnvVaultRoot", () => {
  const ENV = (path: string | undefined) => ({ OBSIDIAN_TC_VAULT_PATH: path });
  let base = "";
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  beforeEach(() => {
    base = makeTempDir("obtc-ensure-root-");
    temps.push(base);
    logged.length = 0;
  });

  it("creates a missing env path under an existing parent and logs one line", () => {
    const target = join(base, "vault");
    expect(ensureEnvVaultRoot([{ path: target }], ENV(target), log)).toBe("created");
    expect(statSync(target).isDirectory()).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(target);
  });

  it("skips when the variable is unset or empty, creating nothing", () => {
    const target = join(base, "vault");
    expect(ensureEnvVaultRoot([{ path: target }], ENV(undefined), log)).toBe("skipped");
    expect(ensureEnvVaultRoot([{ path: target }], ENV(""), log)).toBe("skipped");
    expect(() => statSync(target)).toThrow();
    expect(logged).toHaveLength(0);
  });

  it("skips when the one vault's path differs from the variable (hand-built config)", () => {
    const target = join(base, "vault");
    const other = join(base, "other");
    expect(ensureEnvVaultRoot([{ path: other }], ENV(target), log)).toBe("skipped");
    expect(() => statSync(target)).toThrow();
  });

  it("skips when the config names several vaults", () => {
    const target = join(base, "vault");
    const vaults = [{ path: target }, { path: join(base, "b") }];
    expect(ensureEnvVaultRoot(vaults, ENV(target), log)).toBe("skipped");
    expect(() => statSync(target)).toThrow();
  });

  it("skips an existing directory and leaves its mode alone", () => {
    const target = join(base, "vault");
    mkdirSync(target);
    chmodSync(target, 0o755);
    expect(ensureEnvVaultRoot([{ path: target }], ENV(target), log)).toBe("skipped");
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(logged).toHaveLength(0);
  });

  it("skips when the parent is missing and does not create it", () => {
    const parent = join(base, "data");
    const target = join(parent, "vault");
    expect(ensureEnvVaultRoot([{ path: target }], ENV(target), log)).toBe("skipped");
    expect(() => statSync(parent)).toThrow();
  });

  describe.skipIf(process.platform === "win32")("POSIX links and ownership", () => {
    it("refuses a symlinked parent and creates nothing through it", () => {
      const real = join(base, "real");
      mkdirSync(real);
      const link = join(base, "link");
      symlinkSync(real, link);
      const target = join(link, "vault");
      expect(() => ensureEnvVaultRoot([{ path: target }], ENV(target), log)).toThrow(
        /parent .* is a symlink/,
      );
      expect(readdirSync(real)).toEqual([]);
    });

    it("leaves a dangling symlink at the path untouched", () => {
      const dangling = join(base, "vault");
      const goal = join(base, "elsewhere");
      symlinkSync(goal, dangling);
      expect(ensureEnvVaultRoot([{ path: dangling }], ENV(dangling), log)).toBe("skipped");
      expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
      expect(() => statSync(goal)).toThrow();
    });

    it("creates the root owned by the current uid", () => {
      const target = join(base, "vault");
      expect(ensureEnvVaultRoot([{ path: target }], ENV(target), log)).toBe("created");
      expect(statSync(target).uid).toBe(process.getuid?.());
    });
  });
});
