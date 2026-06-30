import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "./args";

interface PluginManifest {
  id: string;
  name: string;
  version: string;
}

export interface PluginInstallResult {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  dest: string;
}

/**
 * Copy the bundled companion plugin (main.js + manifest.json) into
 * `<vaultPath>/.obsidian/plugins/<id>/`. `pluginSrcDir` is the directory the server build
 * vendored the plugin into (dist/plugin); it is a parameter so tests can inject a fixture.
 * Overwrites an existing install (an in-place upgrade); the user enables it in Obsidian.
 */
export function installPlugin(vaultPath: string, pluginSrcDir: string): PluginInstallResult {
  const vault = resolve(vaultPath);
  let vaultStat: ReturnType<typeof statSync>;
  try {
    vaultStat = statSync(vault);
  } catch {
    throw new CliError(`no such vault folder: ${vaultPath}`);
  }
  if (!vaultStat.isDirectory()) throw new CliError(`not a directory: ${vaultPath}`);

  let manifestRaw: string;
  let mainJs: Buffer;
  try {
    manifestRaw = readFileSync(join(pluginSrcDir, "manifest.json"), "utf8");
    mainJs = readFileSync(join(pluginSrcDir, "main.js"));
  } catch {
    throw new CliError(
      "bundled companion plugin not found; this build did not vendor it (expected dist/plugin/).",
    );
  }
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(manifestRaw) as PluginManifest;
  } catch {
    throw new CliError("bundled companion plugin manifest.json is not valid JSON.");
  }
  if (!manifest.id) throw new CliError("companion plugin manifest is missing an id");
  if (!manifest.name || !manifest.version)
    throw new CliError("companion plugin manifest is missing name or version");

  const dest = join(vault, ".obsidian", "plugins", manifest.id);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), manifestRaw);
  writeFileSync(join(dest, "main.js"), mainJs);
  return {
    pluginId: manifest.id,
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    dest,
  };
}
