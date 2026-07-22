// THE-522: Obsidian discovery — registry, config-dir resolution, plugin scan. All filesystem, so
// the tests build real temp vaults rather than mock fs.
//
// Three research findings drive the shape here and each has a test:
//   - obsidian.json is de-facto structure, not a contract: parse defensively (missing file, absent
//     `path`, junk siblings) and derive display names from the directory basename since there is no
//     name field.
//   - the config folder is NOT always `.obsidian`: it is user-overridable, so resolveConfigDir
//     probes `.obsidian` first, then scans for a dot-dir carrying app.json/community-plugins.json,
//     then honours an explicit override. The override name is not derivable from the vault name.
//   - "no Obsidian" is a first-class state: an absent registry yields an empty vault list, not a throw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverPlugins, parseRegistry, resolveConfigDir } from "../src/capability/discovery";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "obtc-cap-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function vault(name: string, configDirName = ".obsidian"): string {
  const v = join(root, name);
  const cfg = join(v, configDirName);
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "app.json"), "{}");
  return v;
}

function installPlugin(
  vaultPath: string,
  folder: string,
  manifest: object,
  configDir = ".obsidian",
) {
  const dir = join(vaultPath, configDir, "plugins", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("THE-522 registry parsing", () => {
  it("extracts vaults with basename-derived display names", () => {
    const raw = JSON.stringify({
      vaults: {
        f787eb741abe7d4a: { path: "/home/u/Documents/Obsidian Vault", ts: 1, open: true },
        a1b2c3: { path: "/home/u/second-brain", ts: 2 },
      },
      cli: true,
    });
    const vaults = parseRegistry(raw);
    expect(vaults).toHaveLength(2);
    const first = vaults.find((v) => v.id === "f787eb741abe7d4a");
    expect(first?.path).toBe("/home/u/Documents/Obsidian Vault");
    expect(first?.name).toBe("Obsidian Vault"); // basename, since the registry has no name field
    expect(first?.open).toBe(true);
    expect(vaults.find((v) => v.id === "a1b2c3")?.open).toBe(false); // absent open -> false
  });

  it("skips registry entries with no path rather than emitting a broken vault", () => {
    const raw = JSON.stringify({ vaults: { good: { path: "/v" }, bad: { ts: 5 } } });
    const vaults = parseRegistry(raw);
    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.id).toBe("good");
  });

  it("returns [] for an absent-registry shape instead of throwing (the no-Obsidian case)", () => {
    expect(parseRegistry("{}")).toEqual([]);
    expect(parseRegistry('{"cli":true}')).toEqual([]);
  });

  it("returns [] on unparseable registry JSON", () => {
    expect(parseRegistry("{ broken")).toEqual([]);
  });
});

describe("THE-522 config-dir resolution", () => {
  it("finds the default .obsidian directory", () => {
    const v = vault("default-vault");
    const r = resolveConfigDir(v);
    expect(r?.name).toBe(".obsidian");
    expect(r?.overridden).toBe(false);
  });

  it("finds a user-overridden config folder by scanning for its marker file", () => {
    const v = vault("override-vault", ".obsidian-awesome");
    const r = resolveConfigDir(v);
    expect(r?.name).toBe(".obsidian-awesome");
    expect(r?.overridden).toBe(true); // not the default name
  });

  it("honours an explicit override even when .obsidian also exists", () => {
    const v = vault("both-vault", ".obsidian");
    mkdirSync(join(v, ".obsidian-custom"), { recursive: true });
    writeFileSync(join(v, ".obsidian-custom", "app.json"), "{}");
    const r = resolveConfigDir(v, ".obsidian-custom");
    expect(r?.name).toBe(".obsidian-custom");
  });

  it("returns null when the vault has no config directory at all", () => {
    const bare = join(root, "not-a-vault");
    mkdirSync(bare, { recursive: true });
    expect(resolveConfigDir(bare)).toBeNull();
  });
});

describe("THE-522 plugin discovery", () => {
  const manifest = (id: string) => ({
    id,
    name: id,
    version: "1.0.0",
    minAppVersion: "1.0.0",
    author: "a",
    description: "d",
  });

  it("reports installed plugins and marks which are enabled", () => {
    const v = vault("plugin-vault");
    installPlugin(v, "obsidian-local-rest-api", manifest("obsidian-local-rest-api"));
    installPlugin(v, "smart-connections", manifest("smart-connections"));
    installPlugin(v, "dataview", manifest("dataview"));
    // community-plugins.json is the ONLY source of enabled-state.
    writeFileSync(
      join(v, ".obsidian", "community-plugins.json"),
      JSON.stringify(["obsidian-local-rest-api", "dataview"]),
    );

    const r = discoverPlugins(v);
    expect(r.installed.map((p) => p.id).sort()).toEqual([
      "dataview",
      "obsidian-local-rest-api",
      "smart-connections",
    ]);
    const rest = r.installed.find((p) => p.id === "obsidian-local-rest-api");
    expect(rest?.enabled).toBe(true);
    expect(r.installed.find((p) => p.id === "smart-connections")?.enabled).toBe(false);
  });

  it("collects an unreadable manifest into a separate bucket instead of dropping the scan", () => {
    const v = vault("mixed-vault");
    installPlugin(v, "good", manifest("good"));
    const bad = join(v, ".obsidian", "plugins", "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "manifest.json"), "{ not json");

    const r = discoverPlugins(v);
    expect(r.installed.map((p) => p.id)).toEqual(["good"]); // the good one still lands
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0]?.folder).toBe("broken");
  });

  it("surfaces a folder/id mismatch as a warning on the plugin record", () => {
    const v = vault("brat-vault");
    installPlugin(v, "dev-folder-name", manifest("real-plugin-id"));
    const r = discoverPlugins(v);
    expect(r.installed[0]?.folderIdMismatch).toBe(true);
  });

  it("returns empty results for a vault with no plugins directory", () => {
    const v = vault("empty-vault");
    const r = discoverPlugins(v);
    expect(r.installed).toEqual([]);
    expect(r.unreadable).toEqual([]);
  });
});
