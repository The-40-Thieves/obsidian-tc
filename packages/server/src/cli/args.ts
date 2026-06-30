import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { finalizeConfig, loadConfig } from "../config/load";

export type CliCommand =
  | { kind: "serve"; input?: string }
  | { kind: "config-show"; configPath?: string }
  | { kind: "config-validate"; configPath?: string }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const USAGE = `obsidian-tc — MCP server for Obsidian

Usage:
  obsidian-tc <vault-dir | config.json>   Start the server (zero-config from a vault folder, or a config file)
  obsidian-tc serve [path]                Same as above; path may be a vault folder or a config file
  obsidian-tc config show [path]          Print the effective config with secrets redacted
  obsidian-tc config validate [path]      Validate the config (exit non-zero on error)
  obsidian-tc version                     Print the version
  obsidian-tc help                        Show this help

If no path is given, OBSIDIAN_TC_CONFIG is used. A vault folder boots a single
vault with id "main" and all defaults; pass a config file for multi-vault, auth,
ACLs, transports, and embeddings.
`;

/** A user-facing CLI error: its message is meant to be printed without a stack trace. */
export class CliError extends Error {
  readonly cli = true;
}

function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Parse argv already sliced past the node binary + script path into a command. */
export function parseCliArgs(argv: string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "serve" };
  if (first === "version" || first === "--version" || first === "-v") return { kind: "version" };
  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "serve") {
    return { kind: "serve", input: flagValue(rest, "--config") ?? positional(rest) };
  }
  if (first === "config") {
    const sub = rest[0];
    const configPath = flagValue(rest, "--config") ?? positional(rest.slice(1));
    if (sub === "show") return { kind: "config-show", configPath };
    if (sub === "validate") return { kind: "config-validate", configPath };
    return { kind: "error", message: `unknown config subcommand: ${sub ?? "(none)"}` };
  }
  if (first.startsWith("-")) return { kind: "error", message: `unknown option: ${first}` };
  return { kind: "serve", input: first };
}

/** Build a single-vault config from a vault directory, applying every schema default. */
export function configFromVaultPath(dir: string): ServerConfig {
  return finalizeConfig({ vaults: [{ id: "main", path: resolve(dir) }] });
}

/**
 * Resolve a serve target. A directory boots zero-config (a single vault "main");
 * a file is loaded as a config; absent falls back to OBSIDIAN_TC_CONFIG.
 */
export function resolveServeConfig(input?: string): ServerConfig {
  const target = input ?? process.env.OBSIDIAN_TC_CONFIG;
  if (!target) {
    throw new CliError(
      "no vault or config given: pass a vault folder or a config.json (or set OBSIDIAN_TC_CONFIG).",
    );
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch {
    throw new CliError(`no such vault folder or config file: ${target}`);
  }
  return stat.isDirectory() ? configFromVaultPath(target) : loadConfig(target);
}

const SECRET_KEY = /(secret|token|password|api[_-]?key|apikey)$/i;

/** Deep-clone a value with secret-looking string fields masked, for `config show`. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        typeof v === "string" && v.length > 0 && SECRET_KEY.test(k)
          ? "<redacted>"
          : redactConfig(v);
    }
    return out;
  }
  return value;
}
