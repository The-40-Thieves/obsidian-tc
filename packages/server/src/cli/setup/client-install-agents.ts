// PR C follow-up: the nine clients from this repo's own MCP-client research pass
// (research/obsidian-tc-mcp-clients-2026-09-28/clients.md) not yet wired into `setup
// --install-client` — Cline, Roo Code, Continue, Goose, Amazon Q Developer CLI, Kiro, JetBrains,
// Warp, and Augment/Auggie. Split out of client-install-editors.ts (rather than grown into it) to
// stay under biome's 700-line ceiling, the same reason that file itself split from
// client-install.ts. Every mechanism here was checked against that client's own current docs
// (WebFetch against the live doc URL cited in each `sourceNote`, 2026-09-28) before being added;
// where a doc fetch could not confirm a mechanism precisely enough to auto-execute (a `mcp add`
// CLI's exact argv shape, or a config path the operator's docs never state), the entry is
// `instructions-only` instead of guessed into a `cli`/`*-merge` one — see `amazonQInstructions` and
// `jetbrainsInstructions`'s own headers for which and why.
import { join } from "node:path";
import type { ClientRegistryEntry } from "./client-install-types";

/** The nine client ids this module owns — a literal union (not `InstallClient` itself, mirroring
 *  `EditorInstallClient`'s own reasoning: importing from parse-setup.ts here risks a cycle
 *  `check:boundaries` would catch, and a literal union makes `AGENT_CLIENT_REGISTRY` below checked
 *  EXHAUSTIVE by the compiler rather than only by the registry-completeness test). */
export type AgentInstallClient =
  | "cline"
  | "roo"
  | "continue"
  | "goose"
  | "amazonq"
  | "kiro"
  | "jetbrains"
  | "warp"
  | "augment";

/** Both Cline and Roo Code store their MCP settings under the SAME VS Code `globalStorage`
 *  per-extension layout this repo's other VS Code-hosted clients don't need (opencode/Zed are
 *  standalone apps, not extensions) — one path builder shared by both, parameterized on the
 *  extension id and settings filename, so the two don't duplicate the three-OS branch. */
function vscodeExtensionSettingsPath(
  extensionId: string,
  fileName: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const globalStorageBase =
    platform === "win32"
      ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "globalStorage")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "Code", "User", "globalStorage")
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Code", "User", "globalStorage");
  return join(globalStorageBase, extensionId, "settings", fileName);
}

/** Cline (VS Code extension id `saoudrizwan.claude-dev`) — docs.cline.bot/mcp/configuring-mcp-servers
 *  (web-verified 2026-09-28) documents the JSON shape (`command`/`args`/`env`/`disabled`/
 *  `autoApprove`) and that the in-app "Configure MCP Servers" action opens this exact file; the
 *  file's own name (`cline_mcp_settings.json`) and its globalStorage location are corroborated by
 *  the extension's own source (github.com/cline/cline/discussions/2355) — the standard VS Code
 *  globalStorage convention `vscodeExtensionSettingsPath` above already encodes for opencode's own
 *  sibling research. A separate, unrelated standalone Cline CLI product has its OWN `~/.cline/
 *  mcp.json` (docs.cline.bot's own text) — not this one, and not wired in here (no stdio `mcp add`
 *  argv shape was found documented for it to build a `cli`-kind entry against). */
export function clineMcpSettingsPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  return vscodeExtensionSettingsPath(
    "saoudrizwan.claude-dev",
    "cline_mcp_settings.json",
    platform,
    env,
    home,
  );
}

export function clineServerEntry(configPath: string): Record<string, unknown> {
  return {
    command: "obsidian-tc",
    args: ["--config", configPath],
    env: {},
    disabled: false,
    autoApprove: [],
  };
}

/** Roo Code (Cline fork, VS Code extension id `rooveterinaryinc.roo-cline`) —
 *  roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo (web-verified 2026-09-28, fetched
 *  after docs.roocode.com's own redirect) confirms the filename is `mcp_settings.json` (NOT
 *  Cline's `cline_mcp_settings.json` — a different name at the analogous globalStorage path) and
 *  the stdio shape uses `alwaysAllow` where Cline uses `autoApprove`. */
export function rooMcpSettingsPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  return vscodeExtensionSettingsPath(
    "rooveterinaryinc.roo-cline",
    "mcp_settings.json",
    platform,
    env,
    home,
  );
}

export function rooServerEntry(configPath: string): Record<string, unknown> {
  return {
    command: "obsidian-tc",
    args: ["--config", configPath],
    env: {},
    alwaysAllow: [],
    disabled: false,
  };
}

/** Continue (docs.continue.dev/customize/deep-dives/mcp, web-verified 2026-09-28) documents TWO
 *  mechanisms: a top-level `mcpServers:` LIST in the shared `config.yaml` (which this repo's own
 *  `mergeMcpServersEntryYaml` cannot merge into safely — a YAML sequence has no name-keyed slot to
 *  find/replace an existing `obsidian-tc` entry in without risking a duplicate on re-run), and a
 *  STANDALONE per-server file under `.continue/mcpServers/*.yaml` meant for exactly this
 *  ("individual YAML files... for team sharing" per that doc) — this uses the standalone file, a
 *  brand-new `obsidian-tc.yaml` written with `serversPath: []` (see `YamlMergeClientSpec`'s own doc
 *  comment), sidestepping the list-merge problem entirely: the file belongs to obsidian-tc alone. */
export function continueMcpServerFilePath(home: string): string {
  return join(home, ".continue", "mcpServers", "obsidian-tc.yaml");
}

export function continueServerEntry(configPath: string): Record<string, unknown> {
  return {
    name: "obsidian-tc",
    version: "0.0.1",
    schema: "v1",
    mcpServers: [
      {
        name: "obsidian-tc",
        type: "stdio",
        command: "obsidian-tc",
        args: ["--config", configPath],
      },
    ],
  };
}

/** Goose (Block) — block.github.io/goose/docs/guides/config-file redirects to goose-docs.ai/docs/
 *  guides/config-file as of this pass (a JS-rendered page a plain fetch cannot read; confirmed via
 *  a web search of the same underlying content, cross-checked against this repo's own prior
 *  research note, both agreeing on the field set below) — `~/.config/goose/config.yaml`,
 *  `extensions` a mapping keyed by extension name, each stdio entry carrying `bundled`,
 *  `description`, `enabled`, `name`, `timeout`, `type: stdio`, `cmd`, `args`, `env_keys`, `envs`.
 *  Windows path (`%APPDATA%\Block\goose\config\config.yaml`) is this repo's own prior research note
 *  only — not independently re-confirmed this pass, since the Windows-specific doc page was not
 *  reachable either; still preferred over guessing a fresh path with no citation at all. */
export function gooseConfigPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Block",
      "goose",
      "config",
      "config.yaml",
    );
  }
  return join(home, ".config", "goose", "config.yaml");
}

export function gooseServerEntry(configPath: string): Record<string, unknown> {
  return {
    bundled: false,
    description: "obsidian-tc MCP server",
    enabled: true,
    name: "obsidian-tc",
    timeout: 300,
    type: "stdio",
    cmd: "obsidian-tc",
    args: ["--config", configPath],
    env_keys: [],
    envs: {},
  };
}

/** Amazon Q Developer CLI — docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/qdev-mcp.html and
 *  github.com/aws/amazon-q-developer-cli's own agent-format.md (both web-verified 2026-09-28)
 *  confirm the CURRENT mechanism is per-agent JSON files under `~/.aws/amazonq/cli-agents/`, each
 *  with its own `mcpServers` field, and that the older shared `~/.aws/amazonq/mcp.json` is legacy
 *  — only read at all when an agent explicitly sets `"useLegacyMcpJson": true`. Neither doc page
 *  disclosed a `q mcp add` CLI command's argv shape (the AWS doc names only `q settings
 *  mcp.initTimeout`), so this is `instructions-only` rather than a `cli`/`json-merge` entry guessed
 *  from an earlier research pass's unconfirmed claim — writing straight to the legacy path would
 *  risk a config Amazon Q's own CLI never reads back without that opt-in flag, a `declared but not
 *  running` outcome this repo's own conventions treat as worse than printing instructions. */
export function amazonQInstructions(): string {
  return [
    "Amazon Q Developer CLI's MCP config depends on which agent you use — no single file is",
    "guaranteed to be read, so this only prints instructions (docs.aws.amazon.com/amazonq/latest/",
    "qdeveloper-ug/qdev-mcp.html, github.com/aws/amazon-q-developer-cli's own agent-format.md):",
    "",
    "Current mechanism (per-agent JSON, ~/.aws/amazonq/cli-agents/<agent>.json) — add to that",
    'agent\'s own "mcpServers" field:',
    '  {"mcpServers":{"obsidian-tc":{"command":"obsidian-tc","args":["--config","<config-path>"]}}}',
    "",
    "Legacy mechanism (~/.aws/amazonq/mcp.json) — only read if the agent's own JSON sets",
    '"useLegacyMcpJson": true; same "mcpServers" shape as above, at that shared path instead.',
  ].join("\n");
}

/** Kiro (AWS) — kiro.dev/docs/mcp/configuration (web-verified 2026-09-28): global
 *  `~/.kiro/settings/mcp.json`, same JSON shape on every OS (no platform branching shown in that
 *  doc — no `%APPDATA%`/XDG alternative documented, unlike Claude Desktop/Zed). */
export function kiroMcpConfigPath(home: string): string {
  return join(home, ".kiro", "settings", "mcp.json");
}

export function kiroServerEntry(configPath: string): Record<string, unknown> {
  return {
    command: "obsidian-tc",
    args: ["--config", configPath],
    env: {},
    disabled: false,
    autoApprove: [],
  };
}

/** JetBrains AI Assistant — jetbrains.com/help/ai-assistant/mcp.html (this repo's own prior
 *  research pass; UI-only clients like this one and ChatGPT/Devin cloud have no doc-disclosed path
 *  to re-verify against). Settings | Tools | AI Assistant | MCP → Add → paste JSON into a dialog —
 *  no on-disk path is documented at all, so this can only ever be `instructions-only`. (JetBrains'
 *  separate Junie product DOES have a file-backed `~/.junie/mcp/mcp.json`, per that same research
 *  pass — not wired in here: it was not on this brief's client list, and the precedence between its
 *  project/user scopes was left UNVERIFIED there.) */
export function jetbrainsInstructions(): string {
  return [
    "JetBrains AI Assistant has no disclosed on-disk MCP config path — it is UI-only",
    "(jetbrains.com/help/ai-assistant/mcp.html): open Settings | Tools | AI Assistant | Model",
    "Context Protocol (MCP), click Add, and choose the STDIO tab. Paste:",
    '  {"mcpServers":{"obsidian-tc":{"command":"obsidian-tc","args":["--config","<config-path>"]}}}',
    "and pick a Server level (Global or Project) in that same dialog.",
  ].join("\n");
}

/** Warp (terminal) — docs.warp.dev/knowledge-and-collaboration/mcp (web-verified 2026-09-28):
 *  file-based, `~/.warp/.mcp.json`, entries live at the file's OWN top level (`{"ServerName": {...
 *  }}`) with NO wrapping `"mcpServers"` key — `serversKey: ""` (see `mergeMcpServersEntry`'s own
 *  root-level handling). The in-app `/agent-add-mcp` skill edits this same file but is invoked from
 *  inside Warp's own agent chat, not a shell command — no standalone `warp mcp add` CLI exists to
 *  wire in as a `cli`-kind entry instead. */
export function warpMcpConfigPath(home: string): string {
  return join(home, ".warp", ".mcp.json");
}

export function warpServerEntry(configPath: string): Record<string, unknown> {
  return { command: "obsidian-tc", args: ["--config", configPath], env: {} };
}

/** Augment Code's Auggie CLI — docs.augmentcode.com/cli/integrations (web-verified 2026-09-28)
 *  documents `auggie mcp add <name> --command <path> --args <args> [-e KEY=VAL] [-t transport]`,
 *  where `--args` takes ONE string (not a repeatable flag) — exactly what a human pasting this same
 *  line into their own shell would also pass as a single quoted token, so `formatCliInstallLine`'s
 *  own quoting already covers it correctly. The separate VS Code extension surface
 *  (`augment.advanced.mcpServers`, an array, edited via its own Settings UI) has no CLI/file
 *  mechanism documented and is not wired in here — this is the Auggie CLI only. */
export function augmentAddCommand(configPath: string): string[] {
  return [
    "mcp",
    "add",
    "obsidian-tc",
    "--command",
    "obsidian-tc",
    "--args",
    `--config ${configPath}`,
  ];
}

export const AGENT_CLIENT_REGISTRY: Record<AgentInstallClient, ClientRegistryEntry> = {
  cline: {
    kind: "json-merge",
    displayName: "Cline",
    configPath: clineMcpSettingsPath,
    serversKey: "mcpServers",
    buildEntry: clineServerEntry,
    sourceNote:
      "docs.cline.bot/mcp/configuring-mcp-servers, github.com/cline/cline/discussions/2355 " +
      "(web-verified 2026-09-28)",
  },
  roo: {
    kind: "json-merge",
    displayName: "Roo Code",
    configPath: rooMcpSettingsPath,
    serversKey: "mcpServers",
    buildEntry: rooServerEntry,
    sourceNote:
      "roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo (web-verified 2026-09-28)",
  },
  continue: {
    kind: "yaml-merge",
    displayName: "Continue",
    configPath: (_platform, _env, home) => continueMcpServerFilePath(home),
    serversPath: [],
    buildEntry: continueServerEntry,
    sourceNote: "docs.continue.dev/customize/deep-dives/mcp (web-verified 2026-09-28)",
  },
  goose: {
    kind: "yaml-merge",
    displayName: "Goose",
    configPath: gooseConfigPath,
    serversPath: ["extensions"],
    buildEntry: gooseServerEntry,
    sourceNote:
      "goose-docs.ai/docs/guides/config-file, formerly block.github.io/goose/docs/guides/" +
      "config-file (web-verified 2026-09-28 via web search of the same content; this repo's own " +
      "prior research note agrees on the field set)",
  },
  amazonq: {
    kind: "instructions-only",
    displayName: "Amazon Q Developer CLI",
    instructions: amazonQInstructions,
    sourceNote:
      "docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/qdev-mcp.html, " +
      "github.com/aws/amazon-q-developer-cli's own agent-format.md (web-verified 2026-09-28 — no " +
      "`q mcp add` CLI argv shape or single stable config path was disclosed)",
  },
  kiro: {
    kind: "json-merge",
    displayName: "Kiro",
    configPath: (_platform, _env, home) => kiroMcpConfigPath(home),
    serversKey: "mcpServers",
    buildEntry: kiroServerEntry,
    sourceNote: "kiro.dev/docs/mcp/configuration (web-verified 2026-09-28)",
  },
  jetbrains: {
    kind: "instructions-only",
    displayName: "JetBrains AI Assistant",
    instructions: jetbrainsInstructions,
    sourceNote: "jetbrains.com/help/ai-assistant/mcp.html (prior research pass — UI-only, no path)",
  },
  warp: {
    kind: "json-merge",
    displayName: "Warp",
    configPath: (_platform, _env, home) => warpMcpConfigPath(home),
    serversKey: "",
    buildEntry: warpServerEntry,
    sourceNote: "docs.warp.dev/knowledge-and-collaboration/mcp (web-verified 2026-09-28)",
  },
  augment: {
    kind: "cli",
    displayName: "Augment (Auggie CLI)",
    binary: "auggie",
    buildArgs: augmentAddCommand,
    sourceNote: "docs.augmentcode.com/cli/integrations (web-verified 2026-09-28)",
  },
};
