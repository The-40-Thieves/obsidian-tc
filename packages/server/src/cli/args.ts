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
  | { kind: "plugin-install"; vaultPath: string }
  | { kind: "cluster"; input?: string; k?: number }
  | { kind: "error"; message: string };

export const USAGE = `obsidian-tc — MCP server for Obsidian

Usage:
  obsidian-tc <vault-dir | config.json>   Start the server (zero-config from a vault folder, or a config file)
  obsidian-tc serve [path]                Same as above; path may be a vault folder or a config file
  obsidian-tc config show [path]          Print the effective config with secrets redacted
  obsidian-tc config validate [path]      Validate the config (exit non-zero on error)
  obsidian-tc plugin install --vault <p>  Copy the companion plugin into <p>/.obsidian/plugins/
  obsidian-tc cluster [path] [--k N]      Recompute chunk clusters for diversified retrieval (THE-73)
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

// A value-taking flag (e.g. `--config <path>`). Absent flag -> undefined (the caller falls
// back to a positional / env). Present but with no following token, or a token that is itself
// another flag, is a usage error: throw a CliError that parseCliArgs converts to an `error`
// command, so it can never silently fall through to a positional or to the env fallback.
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
  return v;
}

/** Parse argv already sliced past the node binary + script path into a command. */
export function parseCliArgs(argv: string[]): CliCommand {
  try {
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
    if (first === "plugin") {
      const sub = rest[0];
      if (sub === "install") {
        const vaultPath = flagValue(rest, "--vault") ?? positional(rest.slice(1));
        if (!vaultPath)
          throw new CliError(
            "plugin install requires a vault: --vault <path> (or a positional path)",
          );
        return { kind: "plugin-install", vaultPath };
      }
      return { kind: "error", message: `unknown plugin subcommand: ${sub ?? "(none)"}` };
    }
    if (first === "cluster") {
      // Parse --k first and drop it (+ its value) so the config positional is unambiguous.
      let k: number | undefined;
      let scan = rest;
      const ki = rest.indexOf("--k");
      if (ki >= 0) {
        const kv = rest[ki + 1];
        if (kv === undefined || kv.startsWith("-")) throw new CliError("--k requires a value");
        k = Number.parseInt(kv, 10);
        if (!Number.isFinite(k) || k < 1)
          return { kind: "error", message: "--k must be a positive integer" };
        scan = rest.filter((_, idx) => idx !== ki && idx !== ki + 1);
      }
      return { kind: "cluster", input: flagValue(scan, "--config") ?? positional(scan), k };
    }
    if (first.startsWith("-")) return { kind: "error", message: `unknown option: ${first}` };
    return { kind: "serve", input: first };
  } catch (e) {
    // Keep parseCliArgs total: a usage CliError (e.g. `--config` with no value) becomes an
    // `error` command so cli.ts prints the message + usage and exits 2, never `fatal:`/exit 1.
    if (e instanceof CliError) return { kind: "error", message: e.message };
    throw e;
  }
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

// Field-name suffixes whose string values are masked in `config show`. A bare `key$` suffix
// subsumes apiKey/api_key/restApiKey and also covers generic credential fields (signingKey,
// privateKey, encryptionKey, …). Err toward over-redaction: masking a non-secret in a
// display-only dump is harmless, leaking a secret is not.
const SECRET_KEY = /(secret|token|password|key)$/i;
// Credential-carrying HTTP header names (H-5): observability.otel.headers.Authorization and
// morgiana.httpHeaders.Cookie hold bearer tokens / session cookies, but their KEYS don't match
// SECRET_KEY, so `config show` printed their values verbatim. Mask by header name too.
// Case-insensitive; over-redaction of a non-secret display value is harmless.
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)$/i;

/** Deep-clone a value with secret-looking string fields masked, for `config show`. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        typeof v === "string" && v.length > 0 && (SECRET_KEY.test(k) || CREDENTIAL_HEADER.test(k))
          ? "<redacted>"
          : redactConfig(v);
    }
    return out;
  }
  return value;
}
