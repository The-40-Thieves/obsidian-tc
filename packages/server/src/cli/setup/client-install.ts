// PR B of GH #995's two-part follow-up: `obsidian-tc setup --install-client <client>` — wires an
// `obsidian-tc` entry into one MCP client's own config, ONLY when asked. Every path/format below
// was verified against each client's own current docs via context7 before writing this (not
// assumed from training data):
//   - Claude Code (code.claude.com/docs/en/mcp): the CLI owns `.mcp.json`/`~/.claude.json` itself
//     via `claude mcp add <name> -- <command> [args...]`; that doc's own recommended path is to
//     use the command, NOT hand-edit the JSON, so this module prints/runs that command rather
//     than merging JSON the way the other two clients need.
//   - Claude Desktop: `claude_desktop_config.json`, top-level `mcpServers` key, each entry shaped
//     `{ command, args, env? }` — same shape THIS server's own `serve` argv expects.
//   - Cursor (cursor.com/docs/mcp): `~/.cursor/mcp.json` (global), same `mcpServers` shape.
//
// Split pure (path resolvers, entry/command builders, the JSON merge) from I/O (client-install
// command glue lives in cli/commands/setup.ts) the same way cli/setup/decide.ts and write.ts
// split PR A's own logic — every function here is unit-testable with an injected platform/env/
// home, no real filesystem or `claude` binary.
import { join } from "node:path";
import { CliError } from "../cli-error";
import { INSTALL_CLIENTS, type InstallClient } from "../parse-setup";

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

/** The `obsidian-tc` MCP server entry both JSON-config clients (Claude Desktop, Cursor) share —
 *  ONE shape defined once, so a format difference between the two can never creep in unnoticed. */
export function obsidianTcServerEntry(configPath: string): { command: string; args: string[] } {
  return { command: "obsidian-tc", args: ["--config", configPath] };
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
 *  escaping, doubled, PowerShell's own rule for a literal quote inside a single-quoted string. */
export function shellQuoteArg(arg: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (!/[\s'"$`^&|<>()%!]/.test(arg)) return arg;
    return `'${arg.replace(/'/g, "''")}'`;
  }
  // POSIX (bash/zsh/sh): single-quote whenever a shell-meaningful char appears, closing/re-opening
  // around any embedded single quote (`'\''` is the standard POSIX idiom — a literal `'` outside
  // the quoted string, escaped, then back inside a new quoted string).
  if (!/[\s"'$`\\!*?[\]{}();&|<>~#]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Quotes every arg per `shellQuoteArg` and joins with spaces — the exact text a human would type
 *  (or paste) into their own shell to run the same command `execFileSync` runs directly. */
export function shellQuoteArgs(args: string[], platform: NodeJS.Platform): string {
  return args.map((a) => shellQuoteArg(a, platform)).join(" ");
}

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

export interface McpClientMergeResult {
  /** True when an `obsidian-tc` entry was ALREADY present and `force` was not set — `merged` is
   *  then just `existingRaw` unchanged (or `{}` if there was no existing file at all — impossible
   *  in practice since `alreadyExists` requires a prior entry, kept only for the type's honesty). */
  alreadyExists: boolean;
  merged: Record<string, unknown>;
}

/** Merge the obsidian-tc entry into an existing (or absent) `mcpServers` JSON file's raw object —
 *  pure, so "refuse a duplicate unless `force`" and "every other server survives untouched" are
 *  unit-testable without touching a filesystem. Shared by Claude Desktop and Cursor — both use the
 *  identical `{ mcpServers: { <name>: { command, args } } }` shape. */
export function mergeMcpServersEntry(
  existingRaw: Record<string, unknown> | undefined,
  configPath: string,
  opts: { force?: boolean } = {},
): McpClientMergeResult {
  const base: Record<string, unknown> = existingRaw ? { ...existingRaw } : {};
  // Finding 5 (fix round, cross-vendor review): an `mcpServers` key that IS present but is not a
  // plain object (an array, a string, ...) used to fall through the same `? existingServers : {}`
  // ternary as "absent" and get silently REPLACED with `{ "obsidian-tc": ... }` — every server that
  // client config actually had (in whatever shape it was in) was then gone, with no error and no
  // trace beyond a diff of the file. That is a different failure than "no `mcpServers` key at all"
  // (which really is safe to create from scratch) and must be refused, not repaired.
  if (
    "mcpServers" in base &&
    (typeof base.mcpServers !== "object" ||
      base.mcpServers === null ||
      Array.isArray(base.mcpServers))
  ) {
    throw new CliError(
      `this client's config has an "mcpServers" key that is not a JSON object (found ` +
        `${Array.isArray(base.mcpServers) ? "an array" : typeof base.mcpServers}) — refusing to ` +
        "replace it. Fix the file by hand, then re-run.",
    );
  }
  const existingServers =
    typeof base.mcpServers === "object" &&
    base.mcpServers !== null &&
    !Array.isArray(base.mcpServers)
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  const alreadyExists = "obsidian-tc" in existingServers;
  if (alreadyExists && !opts.force) {
    return { alreadyExists: true, merged: base };
  }
  base.mcpServers = { ...existingServers, "obsidian-tc": obsidianTcServerEntry(configPath) };
  return { alreadyExists: false, merged: base };
}

/** Human label for each client id — used only in printed text (snippets, confirmations), never
 *  parsed back. */
export function clientLabel(client: InstallClient): string {
  switch (client) {
    case "claude-code":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "cursor":
      return "Cursor";
  }
}

/** The ready-to-paste snippet block `setup` prints for ALL THREE clients when `--install-client`
 *  is NOT given — an operator's manual alternative to the opt-in installer. Pure (platform/env/
 *  home injected), so it's assertable without touching a filesystem. */
export function formatClientSnippets(
  configPath: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const entry = obsidianTcServerEntry(configPath);
  const desktopPath = claudeDesktopConfigPath(platform, env, home);
  const cursorPath = cursorMcpConfigPath(home);
  const codeCmd = shellQuoteArgs(["claude", ...claudeCodeAddCommand(configPath)], platform);
  // Finding 3: the win32 quoting `shellQuoteArg` applies is a PowerShell literal specifically
  // (not cmd.exe) — label the snippet so an operator pasting it knows which shell it targets.
  const codeCmdLabel = platform === "win32" ? "run (PowerShell)" : "run";
  const jsonEntry = JSON.stringify({ mcpServers: { "obsidian-tc": entry } }, null, 2);
  return [
    "",
    "Connect an MCP client to this config (or run `obsidian-tc setup --install-client <client>`",
    "to have setup wire one in for you):",
    "",
    `  Claude Code — ${codeCmdLabel}: ${codeCmd}`,
    "",
    `  Claude Desktop — merge into ${desktopPath}:`,
    indent(jsonEntry),
    "",
    `  Cursor — merge into ${cursorPath}:`,
    indent(jsonEntry),
    "",
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export type { InstallClient };
// Re-exported so callers that only need the client id list don't have to reach into parse-setup.ts
// for it.
export { INSTALL_CLIENTS };
