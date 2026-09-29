// PR B of GH #995's two-part follow-up: `obsidian-tc setup --install-client <client>` — wires an
// `obsidian-tc` entry into one MCP client's own config, ONLY when asked. Every mechanism below was
// verified against that client's own current docs, or its own installed `--help` output where it
// ships no web docs, before writing this — not assumed from training data. Claude Code, Codex CLI,
// Antigravity, and Hermes Agent each ship their own `<binary> mcp add`-style command (verified
// live: `codex --version` → 0.157.1 + `codex mcp add --help`; `agy --version` → 1.2.12 + `agy mcp
// add --help`; `hermes mcp add --help` against the installed `~/.hermes/hermes-agent` checkout) —
// preferred over hand-editing their `~/.codex/config.toml` / `mcp_config.json` / `config.yaml`
// directly, so none of them needed the TOML/YAML libraries the original brief anticipated. Claude
// Desktop and Cursor instead merge a JSON `mcpServers` file directly (no CLI exists for either).
// ChatGPT has no local install target at all — see `chatgptInstructions` for why.
//
// CLIENT_REGISTRY below is written so a future client with no CLI at all (a TOML/YAML file only)
// is one more entry away: add a `"toml-merge"`/`"yaml-merge"` kind beside `"json-merge"`, backed
// by its own merge module mirroring `mergeMcpServersEntry` — not built speculatively here with no
// consumer to test it against.
//
// Split pure (path resolvers, entry/command builders, the JSON merge, the registry) from I/O
// (cli/commands/setup-install-client.ts) the same way cli/setup/decide.ts and write.ts split PR
// A's own logic — every function here is unit-testable with an injected platform/env/home.
//
// Types (`ClientKind` and every registry-entry interface) and the six clients added after GH #1008
// (VS Code, opencode, Windsurf/Devin Desktop, Gemini CLI, Zed, Devin, plus Aider's explicit
// non-support) live in client-install-types.ts / client-install-editors.ts respectively — split out
// once this file's own original seven clients plus the new ones would have pushed it past biome's
// 700-line ceiling. This file keeps the ORIGINAL seven (Claude Code, Claude Desktop, Cursor, Codex,
// ChatGPT, Antigravity, Hermes) plus a later addition (Grok CLI, xAI's `grok mcp add` — same
// `"cli"`-kind shape as Claude Code/Codex) plus the registry assembly, `clientLabel`, and the
// printed-snippet formatting every kind shares.
import { join } from "node:path";
import { INSTALL_CLIENTS, type InstallClient } from "../parse-setup";
import { AGENT_CLIENT_REGISTRY } from "./client-install-agents";
import { EDITOR_CLIENT_REGISTRY } from "./client-install-editors";
import {
  type ClientRegistryEntry,
  formatCliInstallLine,
  obsidianTcServerEntry,
} from "./client-install-types";
import { mergeMcpServersEntryYaml } from "./yaml-merge";

/** Claude Desktop's config path is OS-specific and each OS reads a different env var for its base
 *  directory — verified via context7 against the client's own docs (macOS: `~/Library/Application
 *  Support/Claude`; Windows: `%APPDATA%\Claude`; Linux: `$XDG_CONFIG_HOME/Claude` or
 *  `~/.config/Claude`, matching this repo's own `capability/locate.ts` XDG convention for the
 *  Obsidian registry). Takes `platform`/`env`/`home` as arguments (never reads
 *  `process.platform`/`process.env`/`os.homedir()` itself) so tests can inject any OS's shape
 *  without actually running on it. */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/** Cursor's GLOBAL mcp.json (cursor.com/docs/mcp: "Create ~/.cursor/mcp.json in your home
 *  directory for tools available everywhere") — same on every OS, no per-platform branching. */
export function cursorMcpConfigPath(home: string): string {
  return join(home, ".cursor", "mcp.json");
}

/** The documented `claude mcp add` invocation (code.claude.com/docs/en/mcp, context7-verified) —
 *  `--scope user`: available in every project, matching what one shared, already-running
 *  obsidian-tc install is for (not a single project's own `.mcp.json`). The `--` separator is
 *  REQUIRED per that doc: without it, `--config` below would be parsed as a `claude` CLI option
 *  rather than passed through to the server command. */
/** Finding 6 (fix round, cross-vendor review): `execFileSync("claude", args, ...)` never goes
 *  through a shell, so the argv array itself is already injection-safe regardless of spaces/quotes
 *  in `configPath` — that part was fine. What was NOT fine is the line this module (and
 *  cli/commands/setup-install-client.ts) PRINT for a human to copy-paste: joined with plain spaces
 *  and no quoting at all, a path containing a space (`--config /Users/Op Name/.obsidian-tc/
 *  config.json`) pastes into the operator's own shell as two broken arguments. Quotes only the
 *  arguments that actually need it (a bare token with no special characters is left unquoted — see
 *  the existing test asserting the literal substring `claude mcp add --scope user obsidian-tc`),
 *  so an ordinary install stays exactly as readable as before.
 *
 *  Finding 3 (fix round 2, cross-vendor review): the win32 branch used to double-quote, which is
 *  wrong for the shell this snippet is actually printed for. PowerShell is the default Windows
 *  terminal (and `formatClientSnippets` below now labels the snippet as such), and a
 *  DOUBLE-quoted PowerShell argument still expands `$var` and backtick escapes inside it; `%VAR%`
 *  also still expands inside cmd.exe's own double quotes. Single-quoting is the one PowerShell
 *  literal form where none of `$`, backtick, or `%VAR%` expand — only an embedded `'` needs
 *  escaping, doubled, PowerShell's own rule for a literal quote inside a single-quoted string.
 *
 *  `shellQuoteArg`/`shellQuoteArgs` themselves now live in client-install-types.ts (imported above)
 *  — re-exported at the bottom of this file so every existing import of them from this module keeps
 *  working unchanged. */
export function claudeCodeAddCommand(configPath: string): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    "obsidian-tc",
    "--",
    "obsidian-tc",
    "--config",
    configPath,
  ];
}

/** `codex mcp add <name> -- <command>...` (`codex mcp add --help`) — no `--scope` flag exists;
 *  Codex's own config has no per-project/user split the way Claude Code's `--scope user` does. */
export function codexAddCommand(configPath: string): string[] {
  return ["mcp", "add", "obsidian-tc", "--", "obsidian-tc", "--config", configPath];
}

/** `agy mcp add <name> <commandOrUrl> [args...]` (`agy mcp add --help`) — flags must come before
 *  `<name>`; `--` is only required when the command/args themselves start with `-`, ours don't. */
export function antigravityAddCommand(configPath: string): string[] {
  return ["mcp", "add", "obsidian-tc", "obsidian-tc", "--config", configPath];
}

/** `hermes mcp add <name> --command <cmd> --args <args...>` (`hermes mcp add --help`) — `--args`
 *  takes every remaining token, so it must be the LAST flag. */
export function hermesAddCommand(configPath: string): string[] {
  return [
    "mcp",
    "add",
    "obsidian-tc",
    "--command",
    "obsidian-tc",
    "--args",
    "--config",
    configPath,
  ];
}

/** xAI's Grok CLI — `grok mcp add [-t stdio|http|sse] [-s user|project] [-e KEY=val]
 *  [-H 'Name: value'] <NAME> [COMMAND_OR_URL] [ARGS]...` (`grok mcp add --help`, verified against
 *  installed grok-cli 1.0.41, matching ~/.grok/docs/user-guide/07-mcp-servers.md's own "CLI
 *  Management" section). `-s user` writes to `~/.grok/config.toml` (the default scope, made
 *  explicit here the same way Claude Code's `--scope user` is — one shared install, available in
 *  every project, not a single project's own `.grok/config.toml`). Everything after `--` is passed
 *  to the server command untouched, same reasoning as `codexAddCommand`'s own `--` separator. */
export function grokAddCommand(configPath: string): string[] {
  return ["mcp", "add", "-s", "user", "obsidian-tc", "obsidian-tc", "--", "--config", configPath];
}

/** ChatGPT ships no local-server MCP client: Developer Mode's connectors speak only to a remote,
 *  public HTTPS MCP server (OpenAI's current Developer Mode / Apps SDK docs, web-verified
 *  2026-09-28) — no CLI or config file here to install into, so this prints instructions only. */
export function chatgptInstructions(): string {
  return [
    "ChatGPT has no local MCP client — Developer Mode's custom connectors only reach a REMOTE,",
    "public HTTPS MCP server (OpenAI's own Developer Mode / Apps SDK docs, available on ChatGPT",
    "Plus/Pro/Business/Enterprise/Edu). There is no stdio option and nothing on this machine for",
    "obsidian-tc to install into, so this only prints instructions — it writes nothing.",
    "",
    "Run ONE shared obsidian-tc HTTP server (JWT auth required past loopback) and point ChatGPT's",
    "Developer Mode connector at its public HTTPS URL:",
    '  docs/wiki/Deployment-Modes.md — "Run one shared server for several clients"',
    "  https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/wiki/Deployment-Modes.md" +
      "#run-one-shared-server-for-several-clients",
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** One MCP client's whole install mechanism. `--install-client <id>` and the no-flag snippet block
 *  (`formatClientSnippets`) both drive off this one table — a future client is one more entry (in
 *  this file for the plain shapes, client-install-editors.ts for a JSONC/instructions/unsupported
 *  one) plus its own tests, not a new code path. See client-install-types.ts's own `ClientKind` doc
 *  comment for what each of the five kinds means; a future TOML/YAML-only client is an anticipated
 *  sixth (`"yaml-merge"`, mirroring jsonc-merge.ts's own split), added the day one actually needs
 *  it — Continue and Goose (both YAML-config, per this repo's own client research) are the known
 *  next candidates, not built speculatively here with no consumer to test it against. */
export const CLIENT_REGISTRY: Record<InstallClient, ClientRegistryEntry> = {
  "claude-code": {
    kind: "cli",
    displayName: "Claude Code",
    binary: "claude",
    buildArgs: claudeCodeAddCommand,
    sourceNote: "code.claude.com/docs/en/mcp (context7-verified)",
  },
  "claude-desktop": {
    kind: "json-merge",
    displayName: "Claude Desktop",
    configPath: claudeDesktopConfigPath,
    serversKey: "mcpServers",
    sourceNote: "context7-verified against Claude Desktop's own docs",
  },
  cursor: {
    kind: "json-merge",
    displayName: "Cursor",
    configPath: (_platform, _env, home) => cursorMcpConfigPath(home),
    serversKey: "mcpServers",
    sourceNote: "cursor.com/docs/mcp (context7-verified)",
  },
  codex: {
    kind: "cli",
    displayName: "Codex CLI",
    binary: "codex",
    buildArgs: codexAddCommand,
    sourceNote: "`codex mcp add --help`, verified against installed codex-cli 0.157.1",
  },
  chatgpt: {
    kind: "instructions-only",
    displayName: "ChatGPT",
    instructions: chatgptInstructions,
    sourceNote:
      "OpenAI's current Developer Mode / Apps SDK connector docs (web-verified 2026-09-28) — " +
      "remote HTTPS MCP only, no local stdio client",
  },
  antigravity: {
    kind: "cli",
    displayName: "Antigravity",
    binary: "agy",
    buildArgs: antigravityAddCommand,
    sourceNote: "`agy mcp add --help`, verified against installed agy 1.2.12",
  },
  hermes: {
    kind: "cli",
    displayName: "Hermes Agent",
    binary: "hermes",
    buildArgs: hermesAddCommand,
    sourceNote: "`hermes mcp add --help`, verified against the installed hermes-agent checkout",
  },
  grok: {
    kind: "cli",
    displayName: "Grok CLI",
    binary: "grok",
    buildArgs: grokAddCommand,
    sourceNote: "`grok mcp add --help`, verified against installed grok-cli 1.0.41",
  },
  ...EDITOR_CLIENT_REGISTRY,
  ...AGENT_CLIENT_REGISTRY,
};

/** Thin lookup into CLIENT_REGISTRY so a label can never drift from the table above. */
export function clientLabel(client: InstallClient): string {
  return CLIENT_REGISTRY[client].displayName;
}

function formatRegistryBlock(
  client: InstallClient,
  configPath: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const entry = CLIENT_REGISTRY[client];
  if (entry.kind === "cli") {
    const cmd = formatCliInstallLine(entry.binary, entry.buildArgs(configPath), platform);
    // Finding 3 (original claude-code fix): the win32 quoting `shellQuoteArg` applies is a
    // PowerShell literal specifically (not cmd.exe) — label every CLI snippet so an operator
    // pasting it knows which shell it targets, not just Claude Code's.
    const label = platform === "win32" ? "run (PowerShell)" : "run";
    return `  ${entry.displayName} — ${label}: ${cmd}`;
  }
  if (entry.kind === "json-merge" || entry.kind === "jsonc-merge") {
    const targetPath = entry.configPath(platform, env, home);
    const buildEntry =
      entry.kind === "json-merge" ? (entry.buildEntry ?? obsidianTcServerEntry) : entry.buildEntry;
    // Warp's `serversKey === ""` (root-level, no wrapping key — see `mergeMcpServersEntry`'s own
    // handling) prints the entry directly rather than nested under an empty-string JSON key.
    const jsonEntry = JSON.stringify(
      entry.serversKey === ""
        ? { "obsidian-tc": buildEntry(configPath) }
        : { [entry.serversKey]: { "obsidian-tc": buildEntry(configPath) } },
      null,
      2,
    );
    const suffix = entry.kind === "jsonc-merge" ? " (comments preserved)" : "";
    return [`  ${entry.displayName} — merge into ${targetPath}${suffix}:`, indent(jsonEntry)].join(
      "\n",
    );
  }
  if (entry.kind === "yaml-merge") {
    const targetPath = entry.configPath(platform, env, home);
    const yamlEntry = mergeMcpServersEntryYaml(
      undefined,
      entry.buildEntry(configPath),
      {},
      entry.serversPath,
    ).text;
    return [
      `  ${entry.displayName} — merge into ${targetPath} (comments preserved):`,
      indent(yamlEntry.trimEnd()),
    ].join("\n");
  }
  if (entry.kind === "unsupported") {
    return `  ${entry.displayName} — ${entry.reason()}`;
  }
  return `  ${entry.displayName} — ${entry.instructions()}`;
}

/** The ready-to-paste snippet block `setup` prints for EVERY known client when `--install-client`
 *  is NOT given. Pure (platform/env/home injected). Iterates INSTALL_CLIENTS, its declared order. */
export function formatClientSnippets(
  configPath: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const lines: string[] = [
    "",
    "Connect an MCP client to this config (or run `obsidian-tc setup --install-client <client>`",
    "to have setup wire one in for you):",
    "",
  ];
  for (const client of INSTALL_CLIENTS) {
    lines.push(formatRegistryBlock(client, configPath, platform, env, home), "");
  }
  return lines.join("\n");
}

// Re-exported so every existing import of these from THIS module (tests included) keeps working
// unchanged now that their definitions live in client-install-types.ts.
export type {
  CliClientSpec,
  ClientKind,
  ClientRegistryEntry,
  InstructionsOnlyClientSpec,
  JsoncMergeClientSpec,
  JsonMergeClientSpec,
  McpClientMergeResult,
  UnsupportedClientSpec,
} from "./client-install-types";
export {
  formatCliInstallLine,
  mergeMcpServersEntry,
  obsidianTcServerEntry,
  shellQuoteArg,
  shellQuoteArgs,
} from "./client-install-types";
export type { InstallClient };
// Re-exported so callers that only need the client id list don't have to reach into parse-setup.ts
// for it.
export { INSTALL_CLIENTS };
