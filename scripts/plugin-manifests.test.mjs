// Tests for the Claude Code / Muse Code plugin manifests under plugins/obsidian-tc and the
// Claude-style marketplace at .claude-plugin/marketplace.json.
//
// Formats checked against the vendors' docs, fetched 2026-10-10:
//   - Claude Code: https://code.claude.com/docs/en/plugins-reference and /plugin-marketplaces
//   - Muse Code:   no plugin reference is published on dev.meta.ai; the manifest shape here is the
//                  one shipped plugins use (see docs/DISTRIBUTION.md), so it is asserted only
//                  structurally and `muse plugins validate` is an owner action.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchConfig } from "./lib/launch-config.mjs";
import { pinnedPackageSpec } from "./lib/plugin-manifest-versions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = "plugins/obsidian-tc";
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const version = readJson("package.json").version;
const launch = launchConfig();
const claude = readJson(`${PLUGIN_DIR}/.claude-plugin/plugin.json`);
const mcp = readJson(`${PLUGIN_DIR}/.mcp.json`);
const muse = readJson(`${PLUGIN_DIR}/.muse-plugin/plugin.json`);
const marketplace = readJson(".claude-plugin/marketplace.json");

test("claude plugin.json: kebab-case name, lockstep version, author, license", () => {
  assert.match(claude.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.doesNotMatch(claude.name, /^(claude|anthropic)/, "reserved prefix");
  assert.equal(claude.version, version);
  assert.equal(typeof claude.description, "string");
  assert.ok(claude.description.length > 0);
  assert.equal(typeof claude.author?.name, "string");
  assert.equal(claude.license, "AGPL-3.0-only");
});

test("claude plugin.json: the config path is a required user option that .mcp.json substitutes", () => {
  const opt = claude.userConfig?.config_path;
  assert.equal(opt?.type, "file");
  assert.equal(opt?.required, true);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder Claude Code expands
  const placeholder = "${user_config.config_path}";
  assert.equal(mcp.mcpServers["obsidian-tc"].env[launch.configEnv], placeholder);
});

const pinnedArgs = ["-y", pinnedPackageSpec(launch.args.at(-1), version)];

test(".mcp.json launches the published npm package over stdio, pinned to this version", () => {
  assert.deepEqual(Object.keys(mcp.mcpServers), ["obsidian-tc"]);
  const s = mcp.mcpServers["obsidian-tc"];
  assert.equal(s.command, launch.command);
  assert.deepEqual(s.args, pinnedArgs, "exact pin: the plugin directory blocks an unpinned npx");
  assert.deepEqual(Object.keys(s.env), [launch.configEnv]);
  assert.equal(s.type ?? "stdio", "stdio");
});

test("marketplace.json: name, owner, one plugin whose source is the plugin dir", () => {
  assert.match(marketplace.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(typeof marketplace.owner?.name, "string");
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, claude.name, "entry name must equal the manifest name");
  assert.equal(entry.source, `./${PLUGIN_DIR}`);
  assert.equal(
    entry.version,
    undefined,
    "the version lives only in plugin.json; a second copy would drift",
  );
});

test("muse plugin.json: schemaVersion 1, lockstep version, mcpServers is an ARRAY of stdio entries", () => {
  assert.equal(muse.schemaVersion, 1);
  assert.equal(muse.name, claude.name);
  assert.equal(muse.version, version);
  assert.deepEqual(muse.compat, { source: "native", manifestDir: ".muse-plugin" });
  assert.ok(Array.isArray(muse.capabilities.mcpServers), "capabilities.mcpServers is an array");
  assert.equal(muse.capabilities.mcpServers.length, 1);
  const [s] = muse.capabilities.mcpServers;
  assert.equal(s.id, "obsidian-tc");
  assert.equal(s.transport, "stdio");
  assert.deepEqual(s.command, [launch.command, ...pinnedArgs]);
});

const hasClaude = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
for (const target of [PLUGIN_DIR, "."]) {
  test(`claude plugin validate ${target}`, {
    skip: hasClaude ? false : "claude CLI not installed here",
  }, () => {
    const r = spawnSync("claude", ["plugin", "validate", target, "--strict"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
}
