// THE-522: the top-level capability profile — the typed artifact doctor (THE-521), presets (THE-509)
// and CI consume. It assembles registry + per-vault plugin discovery + hardware + runtime.
//
// The assembler takes injected inputs (an explicit registry path, explicit add-vault paths, a
// hardware enricher) so it is testable off a real Obsidian install, and so the three findings that
// shaped it are each covered: no-Obsidian is a first-class state, explicit paths are an escape
// hatch, and a per-vault config-dir override is honoured.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCapabilityProfile } from "../src/capability/profile";

let root: string;
const manifest = (id: string) => ({
  id,
  name: id,
  version: "1.0.0",
  minAppVersion: "1.0.0",
  author: "a",
  description: "d",
});

function makeVault(
  name: string,
  plugins: string[],
  enabled: string[],
  configDir = ".obsidian",
): string {
  const v = join(root, name);
  const cfg = join(v, configDir);
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "app.json"), "{}");
  writeFileSync(join(cfg, "community-plugins.json"), JSON.stringify(enabled));
  for (const p of plugins) {
    const dir = join(cfg, "plugins", p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(p)));
  }
  return v;
}

const noEnrich = async () => ({ gpus: [] });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "obtc-prof-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("THE-522 capability profile", () => {
  it("assembles vaults, plugins and enabled-state from a registry", async () => {
    const vaultPath = makeVault(
      "Brain",
      ["obsidian-local-rest-api", "dataview"],
      ["obsidian-local-rest-api"],
    );
    const registry = join(root, "reg.json");
    writeFileSync(
      registry,
      JSON.stringify({ vaults: { abc123: { path: vaultPath, open: true } } }),
    );

    const profile = await resolveCapabilityProfile({ registryPath: registry, enrich: noEnrich });

    expect(profile.obsidian.installed).toBe(true);
    expect(profile.obsidian.vaults).toHaveLength(1);
    const v = profile.obsidian.vaults[0];
    expect(v?.name).toBe("Brain");
    expect(v?.plugins.installed).toHaveLength(2);
    const rest = v?.plugins.installed.find((p) => p.id === "obsidian-local-rest-api");
    expect(rest?.enabled).toBe(true);
  });

  it("treats a missing registry as the supported no-Obsidian state, not an error", async () => {
    const profile = await resolveCapabilityProfile({
      registryPath: join(root, "does-not-exist.json"),
      enrich: noEnrich,
    });
    expect(profile.obsidian.installed).toBe(false);
    expect(profile.obsidian.vaults).toEqual([]);
    expect(profile.obsidian.registryPath).toBeNull();
  });

  it("accepts explicit add-vault paths even with no registry (the escape hatch)", async () => {
    const vaultPath = makeVault("Manual", ["smart-connections"], ["smart-connections"]);
    const profile = await resolveCapabilityProfile({
      registryPath: join(root, "none.json"),
      extraVaultPaths: [vaultPath],
      enrich: noEnrich,
    });
    expect(profile.obsidian.installed).toBe(false); // no registry
    expect(profile.obsidian.vaults).toHaveLength(1);
    expect(profile.obsidian.vaults[0]?.source).toBe("explicit");
    expect(profile.obsidian.vaults[0]?.plugins.installed[0]?.id).toBe("smart-connections");
  });

  it("does not double-count a vault present in both the registry and the explicit list", async () => {
    const vaultPath = makeVault("Dedup", [], []);
    const registry = join(root, "reg2.json");
    writeFileSync(registry, JSON.stringify({ vaults: { d1: { path: vaultPath } } }));
    const profile = await resolveCapabilityProfile({
      registryPath: registry,
      extraVaultPaths: [vaultPath],
      enrich: noEnrich,
    });
    expect(profile.obsidian.vaults).toHaveLength(1);
  });

  it("honours a per-vault config-dir override", async () => {
    const vaultPath = makeVault("Override", ["dataview"], ["dataview"], ".obsidian-awesome");
    const profile = await resolveCapabilityProfile({
      extraVaultPaths: [vaultPath],
      registryPath: join(root, "none.json"),
      enrich: noEnrich,
    });
    const v = profile.obsidian.vaults[0];
    expect(v?.configDir?.overridden).toBe(true);
    expect(v?.plugins.installed[0]?.id).toBe("dataview");
  });

  it("reports runtime and hardware sections", async () => {
    const profile = await resolveCapabilityProfile({
      registryPath: join(root, "none.json"),
      enrich: async () => ({ cpuBrand: "Test CPU", gpus: [] }),
    });
    expect(["bun", "node"]).toContain(profile.runtime.name);
    expect(profile.runtime.version.length).toBeGreaterThan(0);
    expect(typeof profile.runtime.nativeModule).toBe("boolean");
    expect(profile.hardware.cpuBrand).toBe("Test CPU");
    expect(profile.serverVersion.length).toBeGreaterThan(0);
  });
});
