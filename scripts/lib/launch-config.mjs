// The server's stdio launch config, derived from server.json (the MCP Registry manifest) so the
// plugin manifests, the deep links and their tests all read ONE source instead of each restating
// `npx -y obsidian-tc`. Runtime hint: the README's recommended launcher is npx.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The placeholder every install snippet and deep link shows for the config path. */
export const CONFIG_PLACEHOLDER = "/ABSOLUTE/PATH/TO/obsidian-tc.config.json";

/**
 * @param {() => any} [readServerJson] injectable for tests; defaults to the repo's server.json.
 * @returns {{ name: string, command: string, args: string[], configEnv: string, configPlaceholder: string }}
 */
export function launchConfig(
  readServerJson = () => JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8")),
) {
  const server = readServerJson();
  const pkg = (server.packages ?? []).find((p) => p.registryType === "npm");
  if (!pkg)
    throw new Error("server.json has no npm package entry to derive the launch config from");
  const required = (pkg.environmentVariables ?? []).filter((e) => e.isRequired);
  if (required.length !== 1) {
    throw new Error(
      `server.json must declare exactly one required environment variable (the config path); found ${required.length}`,
    );
  }
  return {
    name: "obsidian-tc",
    command: "npx",
    args: ["-y", pkg.identifier],
    configEnv: required[0].name,
    configPlaceholder: CONFIG_PLACEHOLDER,
  };
}
