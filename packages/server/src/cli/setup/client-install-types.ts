// Split out of client-install.ts (PR B follow-up: VS Code/opencode/Windsurf/Zed/Gemini CLI/Devin/
// Aider) purely to stay under biome's 700-line ceiling — the registry itself grew a fourth `kind`
// (`"jsonc-merge"`, for a file format that must preserve comments across an edit) and a fifth
// (`"unsupported"`, for a client with literally no MCP mechanism at all: Aider). Every type here is
// pure/data-only; client-install.ts and client-install-editors.ts both import from here so neither
// imports the other's registry module, keeping `check:boundaries` cycle-free.
import { CliError } from "../cli-error";

/** `"cli"` for a client with its own `<binary> mcp add ...` command; `"json-merge"` for a
 *  `{ <serversKey>: { <name>: entry } }` file where comments are never a concern (Claude
 *  Desktop/Cursor/Windsurf today — none of their docs show a commented example); `"jsonc-merge"`
 *  for the same shape but in a file whose own docs show `//` comments in a real config (opencode,
 *  Zed) — those must be edited in place, never JSON.parse'd and re-serialized (that would silently
 *  drop every comment); `"instructions-only"` when no local install mechanism exists at all
 *  (ChatGPT, Devin — both cloud); `"unsupported"` when the client has no MCP support whatsoever
 *  (Aider) — `--install-client aider` is a real command that must still exit non-zero with a clear
 *  message, not a silent no-op. */
export type ClientKind = "cli" | "json-merge" | "jsonc-merge" | "instructions-only" | "unsupported";

interface ClientRegistryBase {
  /** Human label — used only in printed text, never parsed back. */
  displayName: string;
  /** Where this entry's mechanism was verified — see client-install.ts's file header for the exact
   *  commands, and client-install-editors.ts's own header for the newer clients. */
  sourceNote: string;
}

export interface CliClientSpec extends ClientRegistryBase {
  kind: "cli";
  /** Invoked via `execFileSync(binary, args, ...)` — never a shell. */
  binary: string;
  buildArgs: (configPath: string) => string[];
}

export interface JsonMergeClientSpec extends ClientRegistryBase {
  kind: "json-merge";
  configPath: (
    platform: NodeJS.Platform,
    env: Record<string, string | undefined>,
    home: string,
  ) => string;
  /** The top-level key server entries live under — passed to `mergeMcpServersEntry`'s own param. */
  serversKey: string;
  /** Windsurf only today: its pre-rebrand config path (`~/.codeium/windsurf/mcp_config.json`) is
   *  used INSTEAD of `configPath` when it already exists on disk — an operator with an existing
   *  legacy install must not get a second, disconnected config file. Checked with a plain
   *  `existsSync` in the I/O layer (cli/commands/setup-install-client.ts), same as every other
   *  filesystem read that layer already does un-injected. */
  legacyConfigPath?: (home: string) => string;
  /** The entry written under `serversKey["obsidian-tc"]` — defaults to `obsidianTcServerEntry`
   *  (the plain `{command,args}` shape) when omitted. */
  buildEntry?: (configPath: string) => Record<string, unknown>;
}

export interface JsoncMergeClientSpec extends ClientRegistryBase {
  kind: "jsonc-merge";
  configPath: (
    platform: NodeJS.Platform,
    env: Record<string, string | undefined>,
    home: string,
  ) => string;
  serversKey: string;
  /** Unlike `json-merge`'s optional override, every `jsonc-merge` client's entry shape differs
   *  enough (opencode's `{type:"local",command:[...]}` array-command shape vs Zed's
   *  `{command,args,env}`) that there is no shared default worth having. */
  buildEntry: (configPath: string) => Record<string, unknown>;
}

export interface InstructionsOnlyClientSpec extends ClientRegistryBase {
  kind: "instructions-only";
  instructions: () => string;
}

export interface UnsupportedClientSpec extends ClientRegistryBase {
  kind: "unsupported";
  /** Printed to stderr; `runInstallClient` exits non-zero and writes nothing, regardless of
   *  `--dry-run`/`--force`/`--yes`. */
  reason: () => string;
}

export type ClientRegistryEntry =
  | CliClientSpec
  | JsonMergeClientSpec
  | JsoncMergeClientSpec
  | InstructionsOnlyClientSpec
  | UnsupportedClientSpec;

/** Finding 6 (fix round, cross-vendor review, original claude-code-only fix): `execFileSync`
 *  never goes through a shell, so the argv array itself is already injection-safe — but the LINE
 *  this module prints for a human to copy-paste needs its own quoting. See client-install.ts's own
 *  header for the fuller history (POSIX vs PowerShell quoting rules). */
export function shellQuoteArg(arg: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (!/[\s'"$`^&|<>()%!]/.test(arg)) return arg;
    return `'${arg.replace(/'/g, "''")}'`;
  }
  if (!/[\s"'$`\\!*?[\]{}();&|<>~#]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function shellQuoteArgs(args: string[], platform: NodeJS.Platform): string {
  return args.map((a) => shellQuoteArg(a, platform)).join(" ");
}

/** Quotes a CLI-client's argv (binary + args) into a copy-pasteable line — shared by every
 *  `"cli"` registry entry. */
export function formatCliInstallLine(
  binary: string,
  args: string[],
  platform: NodeJS.Platform,
): string {
  return shellQuoteArgs([binary, ...args], platform);
}

/** The `obsidian-tc` MCP server entry the plain `{command,args}`-shaped clients share (Claude
 *  Desktop, Cursor, Windsurf/Devin Desktop) — ONE shape defined once. A `jsonc-merge` client with a
 *  differently-shaped entry (opencode, Zed) supplies its own `buildEntry` instead of this. */
export function obsidianTcServerEntry(configPath: string): { command: string; args: string[] } {
  return { command: "obsidian-tc", args: ["--config", configPath] };
}

export interface McpClientMergeResult {
  /** True when an `obsidian-tc` entry was ALREADY present and `force` was not set — `merged` is
   *  then just `existingRaw` unchanged (or `{}` if there was no existing file at all — impossible
   *  in practice since `alreadyExists` requires a prior entry, kept only for the type's honesty). */
  alreadyExists: boolean;
  merged: Record<string, unknown>;
}

/** Merge the obsidian-tc entry into an existing (or absent) JSON config file's raw object — pure,
 *  so "refuse a duplicate unless `force`" and "every other server survives untouched" are
 *  unit-testable without touching a filesystem. Shared by every `"json-merge"` registry entry;
 *  `serversKey` defaults to `"mcpServers"` and `buildEntry` defaults to `obsidianTcServerEntry`. */
export function mergeMcpServersEntry(
  existingRaw: Record<string, unknown> | undefined,
  configPath: string,
  opts: { force?: boolean } = {},
  serversKey = "mcpServers",
  buildEntry: (configPath: string) => Record<string, unknown> = obsidianTcServerEntry,
): McpClientMergeResult {
  const base: Record<string, unknown> = existingRaw ? { ...existingRaw } : {};
  // Finding 5 (fix round, cross-vendor review): a `serversKey` that IS present but is not a plain
  // object (an array, a string, ...) used to fall through the same `? existingServers : {}`
  // ternary as "absent" and get silently REPLACED with `{ "obsidian-tc": ... }` — every server that
  // client config actually had (in whatever shape it was in) was then gone, with no error and no
  // trace beyond a diff of the file. That is a different failure than "no `serversKey` key at all"
  // (which really is safe to create from scratch) and must be refused, not repaired.
  if (
    serversKey in base &&
    (typeof base[serversKey] !== "object" ||
      base[serversKey] === null ||
      Array.isArray(base[serversKey]))
  ) {
    throw new CliError(
      `this client's config has a "${serversKey}" key that is not a JSON object (found ` +
        `${Array.isArray(base[serversKey]) ? "an array" : typeof base[serversKey]}) — refusing ` +
        "to replace it. Fix the file by hand, then re-run.",
    );
  }
  const existingServers =
    typeof base[serversKey] === "object" &&
    base[serversKey] !== null &&
    !Array.isArray(base[serversKey])
      ? (base[serversKey] as Record<string, unknown>)
      : {};
  const alreadyExists = "obsidian-tc" in existingServers;
  if (alreadyExists && !opts.force) {
    return { alreadyExists: true, merged: base };
  }
  base[serversKey] = { ...existingServers, "obsidian-tc": buildEntry(configPath) };
  return { alreadyExists: false, merged: base };
}
