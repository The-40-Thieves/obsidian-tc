// PR B follow-up: the six clients added after GH #1008 (VS Code, opencode, Windsurf/Devin Desktop,
// Gemini CLI, Zed, Devin) plus Aider's explicit non-support, split out of client-install.ts to stay
// under biome's 700-line ceiling. Every mechanism here was checked against that client's own
// current docs before being added — WebFetch against the live doc URL cited in each `sourceNote`,
// 2026-09-28, not assumed from training data or carried over unverified from prior research notes.
//
// Two research claims did NOT survive that direct check and are corrected here rather than copied
// through: (1) Zed's docs (zed.dev/docs/ai/mcp, and github.com/zed-industries/zed's own
// docs/src/ai/mcp.md and docs/src/configuring-zed.md, fetched directly) show NO `"source":"custom"`
// field anywhere in the `context_servers` example — an earlier research pass claimed one was
// required; the CURRENT docs, checked here, do not. (2) code.visualstudio.com's own `--add-mcp`
// example embeds `"name"` INSIDE the JSON payload (`code --add-mcp
// "{\"name\":\"my-server\",\"command\":...}"`), unlike every other CLI client here where the name
// is a separate argv token — `vscodeAddMcpPayload` reflects that.
import { join } from "node:path";
import type { ClientRegistryEntry } from "./client-install-types";

/** The seven client ids this module owns — kept as a literal union (not `InstallClient` itself, to
 *  avoid an import from parse-setup.ts that client-install.ts would then also need, risking a cycle
 *  `check:boundaries` would catch) so `EDITOR_CLIENT_REGISTRY` below is checked EXHAUSTIVE by the
 *  compiler: dropping or misspelling a key here is a type error, not a runtime gap caught only by
 *  the registry-completeness test. */
export type EditorInstallClient =
  | "vscode"
  | "opencode"
  | "windsurf"
  | "gemini"
  | "zed"
  | "devin"
  | "aider";

/** `code --add-mcp '{...}'` (code.visualstudio.com/docs/agent-customization/mcp-servers,
 *  web-verified 2026-09-28) writes straight into the user-level `mcp.json` itself — no need to
 *  resolve or hand-edit that file's own (undocumented, possibly JSONC) path at all. */
export function vscodeAddMcpPayload(configPath: string): Record<string, unknown> {
  return { name: "obsidian-tc", command: "obsidian-tc", args: ["--config", configPath] };
}

export function vscodeAddCommand(configPath: string): string[] {
  return ["--add-mcp", JSON.stringify(vscodeAddMcpPayload(configPath))];
}

/** opencode.ai/docs/config (web-verified 2026-09-28): global config is `~/.config/opencode/
 *  opencode.json` on BOTH Linux and macOS (not `Application Support` — checked directly, this is
 *  not the usual macOS convention) and `%APPDATA%\opencode\opencode.json` on Windows. JSONC
 *  (`//` comments) is explicitly documented as supported. */
export function opencodeConfigPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "opencode", "opencode.json");
  }
  return join(home, ".config", "opencode", "opencode.json");
}

/** opencode.ai/docs/mcp-servers: a LOCAL server needs `"type":"local"` and `command` as an ARRAY
 *  (not opencode's own top-level `command`/`args` split every other client here uses) — mixing the
 *  two shapes up would silently fail to start under opencode's own config validation. */
export function opencodeServerEntry(configPath: string): Record<string, unknown> {
  return {
    type: "local",
    command: ["obsidian-tc", "--config", configPath],
    enabled: true,
    environment: {},
  };
}

/** Windsurf's REBRANDED identity (docs.devin.ai/desktop/cascade/mcp, docs.devin.ai/desktop/
 *  devin-local, web-verified 2026-09-28): `~/.config/devin/mcp_config.json` (macOS/Linux, per that
 *  doc's own text — not the `Application Support` convention),
 *  `%APPDATA%\devin\mcp_config.json` (Windows). */
export function windsurfConfigPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "devin", "mcp_config.json");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "devin", "mcp_config.json");
}

/** Windsurf's PRE-rebrand path (Codeium's own `~/.codeium/windsurf/mcp_config.json`) — any install
 *  from before the 2026-06-02 rename still has its `obsidian-tc` entry read from here if this file
 *  exists; see `JsonMergeClientSpec.legacyConfigPath`'s own doc comment for how the I/O layer
 *  chooses between the two. Same on every OS (a Codeium dotfolder under home), no platform
 *  branching. */
export function windsurfLegacyConfigPath(home: string): string {
  return join(home, ".codeium", "windsurf", "mcp_config.json");
}

/** Gemini CLI (github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md,
 *  web-verified via the research pass this file's header names): `gemini mcp add [-s user|project]
 *  [-t stdio|sse|http] [-e K=V] [--trust] <name> <commandOrUrl> [args...]` — same flags-before-name,
 *  no-`--`-needed shape as `antigravityAddCommand` in client-install.ts (the remaining tokens are
 *  the launched command's OWN argv, not further `gemini` flags, regardless of a leading `-`). */
export function geminiAddCommand(configPath: string): string[] {
  return ["mcp", "add", "obsidian-tc", "obsidian-tc", "--config", configPath];
}

/** zed.dev/docs/ai/mcp + github.com/zed-industries/zed's own docs/src/ai/mcp.md and
 *  docs/src/configuring-zed.md (all fetched directly, 2026-09-28): `~/.config/zed/settings.json`
 *  (macOS/Linux, `$XDG_CONFIG_HOME` respected per this repo's own established convention — see
 *  `claudeDesktopConfigPath`), `%APPDATA%\Zed\settings.json` (Windows). */
export function zedSettingsPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Zed", "settings.json");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "zed", "settings.json");
}

/** The three-field shape shown in Zed's OWN current example under `context_servers` — see this
 *  file's header for why no `"source":"custom"` field is included. */
export function zedServerEntry(configPath: string): Record<string, unknown> {
  return { command: "obsidian-tc", args: ["--config", configPath], env: {} };
}

/** Devin (Cognition, cloud — docs.devin.ai/work-with-devin/mcp): MCP is configured through the
 *  cloud workspace's own UI, and a STDIO server the docs describe launches INSIDE Devin's own
 *  session container, never reaching the operator's machine — no bridge or tunnel to a LOCAL stdio
 *  server exists. Devin DESKTOP (the rebranded Windsurf editor, `windsurf`/`devin-desktop` in
 *  `INSTALL_CLIENTS`) is a DIFFERENT product that DOES run locally — named explicitly here so
 *  "Devin" in this list is never mistaken for it. */
export function devinInstructions(): string {
  return [
    "Devin (the cloud agent, docs.devin.ai) has no local-stdio reach — its STDIO MCP launcher runs",
    "INSIDE Devin's own session container, not on this machine, so this only prints instructions —",
    "it writes nothing. (This is DIFFERENT from Devin Desktop, the rebranded Windsurf editor, which",
    "DOES run locally — see `obsidian-tc setup --install-client windsurf` for that one instead.)",
    "",
    "Run ONE shared obsidian-tc HTTP server (JWT auth required past loopback), tunnel it to a",
    "public HTTPS URL, and add it in Devin's workspace UI (Customize > MCPs > Add custom MCP):",
    '  docs/wiki/Deployment-Modes.md — "Run one shared server for several clients"',
    "  https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/wiki/Deployment-Modes.md" +
      "#run-one-shared-server-for-several-clients",
  ].join("\n");
}

/** Aider has NO MCP support at all (no MCP keys in its config reference; RFC issue open,
 *  unmerged). Unlike every other entry here, this is not "no local mechanism" (instructions-only,
 *  ChatGPT/Devin's shape) — there is nothing to point an operator at, so `runInstallClient` prints
 *  this and exits non-zero rather than the exit-0 instructions-only clients use. */
export function aiderUnsupportedReason(): string {
  return (
    "Aider has no MCP support (no `--install-client aider` mechanism exists to wire in): Aider's " +
    "own config reference has no MCP keys, and its MCP RFC (github.com/Aider-AI/aider issue #4506) " +
    "remains open, unmerged. Nothing was written."
  );
}

export const EDITOR_CLIENT_REGISTRY: Record<EditorInstallClient, ClientRegistryEntry> = {
  vscode: {
    kind: "cli",
    displayName: "VS Code (Copilot)",
    binary: "code",
    buildArgs: vscodeAddCommand,
    sourceNote:
      "code.visualstudio.com/docs/agent-customization/mcp-servers (web-verified 2026-09-28)",
  },
  opencode: {
    kind: "jsonc-merge",
    displayName: "opencode",
    configPath: opencodeConfigPath,
    serversKey: "mcp",
    buildEntry: opencodeServerEntry,
    sourceNote: "opencode.ai/docs/config, opencode.ai/docs/mcp-servers (web-verified 2026-09-28)",
  },
  windsurf: {
    kind: "json-merge",
    displayName: "Windsurf / Devin Desktop",
    configPath: windsurfConfigPath,
    legacyConfigPath: windsurfLegacyConfigPath,
    serversKey: "mcpServers",
    sourceNote:
      "docs.devin.ai/desktop/cascade/mcp, docs.devin.ai/desktop/devin-local (web-verified " +
      "2026-09-28) — Windsurf was rebranded Devin Desktop 2026-06-02",
  },
  gemini: {
    kind: "cli",
    displayName: "Gemini CLI",
    binary: "gemini",
    buildArgs: geminiAddCommand,
    sourceNote:
      "github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md (verified research " +
      "pass, 2026-09-28)",
  },
  zed: {
    kind: "jsonc-merge",
    displayName: "Zed",
    configPath: zedSettingsPath,
    serversKey: "context_servers",
    buildEntry: zedServerEntry,
    sourceNote:
      "zed.dev/docs/ai/mcp, github.com/zed-industries/zed docs/src/ai/mcp.md (web-verified " +
      '2026-09-28, superseding an earlier research claim of a required "source":"custom" field)',
  },
  devin: {
    kind: "instructions-only",
    displayName: "Devin (cloud)",
    instructions: devinInstructions,
    sourceNote: "docs.devin.ai/work-with-devin/mcp (web-verified research pass, 2026-09-28)",
  },
  aider: {
    kind: "unsupported",
    displayName: "Aider",
    reason: aiderUnsupportedReason,
    sourceNote:
      "Aider's own config reference (no MCP keys) and open RFC issue #4506 (verified research " +
      "pass, 2026-09-28)",
  },
};
