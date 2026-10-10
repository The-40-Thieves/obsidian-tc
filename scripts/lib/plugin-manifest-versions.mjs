// One inventory of the plugin files that carry the repo version in lockstep.
// release.mjs writes them and check-version-coherence.mjs asserts them, both from this module, so
// a new file cannot be bumped by one and forgotten by the other.
//
// Two kinds of carrier: the manifests' own `version`, and the exact version the plugin's launcher
// pins (`npx -y obsidian-tc@<version>`). The pin is required, not cosmetic: Anthropic's plugin
// directory blocks an unpinned `npx` launcher ("Pin every package that a launcher runs to an exact
// version", claude.com/docs/plugins/pre-submission-checklist, read 2026-10-10), and a plugin whose
// pin trails the package would install an old server under a new plugin version.

/** Repo-relative paths of the Claude Code and Muse Code plugin manifests. */
export const PLUGIN_MANIFEST_PATHS = Object.freeze([
  "plugins/obsidian-tc/.claude-plugin/plugin.json",
  "plugins/obsidian-tc/.muse-plugin/plugin.json",
]);

/** The Claude-style MCP config the Claude Code plugin (and Grok Build) read. */
export const PLUGIN_MCP_JSON = "plugins/obsidian-tc/.mcp.json";

/** The npm package the plugin launches, as `identifier@version`. */
export const pinnedPackageSpec = (identifier, version) => `${identifier}@${version}`;

/** The pin inside a launcher argv (the last element), or undefined when it is not `name@x.y.z`. */
function pinOf(argv) {
  const last = Array.isArray(argv) ? argv.at(-1) : undefined;
  const at = typeof last === "string" ? last.lastIndexOf("@") : -1;
  return at > 0 ? last.slice(at + 1) : undefined;
}

/**
 * `{ label, version }` per lockstep carrier, shaped for check-version-coherence's `sources` list:
 * both manifests' `version`, plus the launcher pin in `.mcp.json` and in the Muse manifest.
 * @param {(path: string) => any} readJson
 */
export function pluginManifestVersionSources(readJson) {
  const [claude, muse] = PLUGIN_MANIFEST_PATHS;
  return [
    { label: claude, version: readJson(claude).version },
    { label: muse, version: readJson(muse).version },
    {
      label: `${PLUGIN_MCP_JSON} launcher pin`,
      version: pinOf(readJson(PLUGIN_MCP_JSON).mcpServers?.["obsidian-tc"]?.args),
    },
    {
      label: `${muse} launcher pin`,
      version: pinOf(readJson(muse).capabilities?.mcpServers?.[0]?.command),
    },
  ];
}
