import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { finalizeConfig, loadConfig } from "../config/load";

export type CliCommand =
  | { kind: "serve"; input?: string }
  | { kind: "config-show"; configPath?: string }
  | { kind: "config-validate"; configPath?: string }
  | { kind: "doctor"; configPath?: string; json?: boolean; token?: string }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "plugin-install"; vaultPath: string }
  | { kind: "cluster"; input?: string; k?: number }
  | { kind: "activation-recompute"; input?: string }
  | {
      kind: "citation-infer";
      input?: string;
      session?: string;
      since?: number;
      until?: number;
      transcript?: string;
    }
  | { kind: "contribution-report"; input?: string; since?: number; until?: number; json?: string }
  | { kind: "prefetch"; input?: string; vault?: string; ttlHours?: number }
  | { kind: "densify-llm"; input?: string; vault?: string }
  | { kind: "reflect"; input?: string; maxJudged?: number }
  | {
      kind: "metrics";
      input?: string;
      vault?: string;
      since?: number;
      until?: number;
      staleDays?: number;
      json?: string;
    }
  | {
      kind: "gaps";
      input?: string;
      vault?: string;
      queries?: string;
      threshold?: number;
      minResults?: number;
      json?: string;
      calibrate?: string;
    }
  | {
      kind: "forget";
      input?: string;
      vault?: string;
      episode?: string;
      note?: string;
      erase?: boolean;
      verify?: boolean;
    }
  | { kind: "error"; message: string };

export const USAGE = `obsidian-tc — MCP server for Obsidian

Usage:
  obsidian-tc <vault-dir | config.json>   Start the server (zero-config from a vault folder, or a config file)
  obsidian-tc serve [path]                Same as above; path may be a vault folder or a config file
  obsidian-tc config show [path]          Print the effective config with secrets redacted
  obsidian-tc config validate [path]      Validate the config (exit non-zero on error)
  obsidian-tc doctor [path] [--json] [--token <jwt>]
                                          Probe runtime health: runtime, native module, auth policy,
                                          token max-age vs expiry, detected Obsidian vaults/plugins.
                                          --json emits the versioned report; --token checks a deployed
                                          credential's age. Exits non-zero when a check fails.
  obsidian-tc plugin install --vault <p>  Copy the companion plugin into <p>/.obsidian/plugins/
  obsidian-tc cluster [path] [--k N]      Recompute chunk clusters for diversified retrieval (THE-73)
  obsidian-tc activation-recompute [path] Recompute ACT-R activation from retrieval history (THE-227)
  obsidian-tc prefetch [path] [--vault id] [--ttl-hours N]
                                          Prewarm the session-bootstrap context cache (THE-136)
  obsidian-tc densify-llm [path] [--vault id]
                                          LLM Pass-3 semantic-edge densification via the local gateway (graph densification)
  obsidian-tc reflect [path] [--max-judged N]
                                          Sleep-time reflect: stamp episode eligibility + update the preference profile (THE-222)
  obsidian-tc metrics [path] [--vault id] [--since ms] [--until ms] [--stale-days N] [--json file]
                                          Knowledge-health scorecard from the derive layer (THE-44/46)
  obsidian-tc gaps [path] --queries <file> [--vault id] [--threshold T] [--min-results N] [--json file]
  obsidian-tc gaps [path] --calibrate <golden.yaml> [--vault id]
                                          Knowledge-gap detector / threshold calibration (THE-48)
  obsidian-tc forget [path] (--episode <id> | --note <rel-path>) [--erase] [--vault id]
  obsidian-tc forget [path] --verify      Dependency-aware deletion + hash-chained audit (THE-239)
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
    if (first === "doctor") {
      // --json and --token are dropped before resolving the positional config path so neither is
      // mistaken for it. --token takes a raw JWT whose iat/exp are read (not verified) by auth.maxAge.
      const json = rest.includes("--json");
      const token = flagValue(rest, "--token");
      const scan = rest.filter((a, i) => {
        if (a === "--json") return false;
        if (a === "--token") return false;
        if (i > 0 && rest[i - 1] === "--token") return false;
        return true;
      });
      const configPath = flagValue(scan, "--config") ?? positional(scan);
      return {
        kind: "doctor",
        ...(configPath !== undefined ? { configPath } : {}),
        json,
        ...(token !== undefined ? { token } : {}),
      };
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
    if (first === "activation-recompute") {
      return {
        kind: "activation-recompute",
        input: flagValue(rest, "--config") ?? positional(rest),
      };
    }
    // Graph densification LLM Pass-3 batch runner.
    if (first === "densify-llm") {
      const scan = [...rest];
      for (const f of ["--vault", "--config", "--batch-size", "--confidence-floor"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      return {
        kind: "densify-llm",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
      };
    }
    // THE-170: on-demand citation inference over a session transcript.
    if (first === "citation-infer") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      // Strip value-carrying flags so positional() cannot mistake a flag value for the config.
      const scan = [...rest];
      for (const f of ["--session", "--since", "--until", "--transcript", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const session = flagValue(rest, "--session");
      const since = num("--since");
      const until = num("--until");
      const transcript = flagValue(rest, "--transcript");
      return {
        kind: "citation-infer",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(session !== undefined ? { session } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(transcript !== undefined ? { transcript } : {}),
      };
    }
    // THE-249: per-note output-contribution report over the experiential telemetry.
    if (first === "contribution-report") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      const scan = [...rest];
      for (const f of ["--since", "--until", "--json", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const since = num("--since");
      const until = num("--until");
      const json = flagValue(rest, "--json");
      return {
        kind: "contribution-report",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(json !== undefined ? { json } : {}),
      };
    }
    // THE-239: dependency-aware deletion — forget an episode or propagate a note deletion.
    if (first === "forget") {
      const scan = [...rest].filter((a) => a !== "--erase" && a !== "--verify");
      for (const f of ["--episode", "--note", "--vault", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const episode = flagValue(rest, "--episode");
      const note = flagValue(rest, "--note");
      const vault = flagValue(rest, "--vault");
      return {
        kind: "forget",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(episode !== undefined ? { episode } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(vault !== undefined ? { vault } : {}),
        ...(rest.includes("--erase") ? { erase: true } : {}),
        ...(rest.includes("--verify") ? { verify: true } : {}),
      };
    }
    // THE-48: knowledge-gap detector over a batch of queries, or golden-set calibration.
    if (first === "gaps") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      const scan = [...rest];
      for (const f of [
        "--vault",
        "--queries",
        "--threshold",
        "--min-results",
        "--json",
        "--calibrate",
        "--config",
      ]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      const queries = flagValue(rest, "--queries");
      const threshold = num("--threshold");
      const minResults = num("--min-results");
      const json = flagValue(rest, "--json");
      const calibrate = flagValue(rest, "--calibrate");
      return {
        kind: "gaps",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(queries !== undefined ? { queries } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(minResults !== undefined ? { minResults } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(calibrate !== undefined ? { calibrate } : {}),
      };
    }
    // THE-44/46: knowledge-health scorecard over the derive layer (chunk_access_stats).
    if (first === "metrics") {
      const num = (flag: string): number | undefined => {
        const v = flagValue(rest, flag);
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
        return n;
      };
      const scan = [...rest];
      for (const f of ["--vault", "--since", "--until", "--stale-days", "--json", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      const since = num("--since");
      const until = num("--until");
      const staleDays = num("--stale-days");
      const json = flagValue(rest, "--json");
      return {
        kind: "metrics",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(staleDays !== undefined ? { staleDays } : {}),
        ...(json !== undefined ? { json } : {}),
      };
    }
    // THE-222: sleep-time reflect — episode-eligibility evaluator + preference-profile update.
    if (first === "reflect") {
      const scan = [...rest];
      for (const f of ["--max-judged", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const mv = flagValue(rest, "--max-judged");
      let maxJudged: number | undefined;
      if (mv !== undefined) {
        maxJudged = Number.parseInt(mv, 10);
        if (!Number.isFinite(maxJudged) || maxJudged < 0)
          return { kind: "error", message: "--max-judged must be a non-negative integer" };
      }
      return {
        kind: "reflect",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(maxJudged !== undefined ? { maxJudged } : {}),
      };
    }
    // THE-136: anticipatory prefetch — compose the bootstrap bundle and write the prewarm cache.
    if (first === "prefetch") {
      const scan = [...rest];
      for (const f of ["--vault", "--ttl-hours", "--config"]) {
        const i = scan.indexOf(f);
        if (i >= 0) scan.splice(i, 2);
      }
      const vault = flagValue(rest, "--vault");
      const tv = flagValue(rest, "--ttl-hours");
      let ttlHours: number | undefined;
      if (tv !== undefined) {
        ttlHours = Number(tv);
        if (!Number.isFinite(ttlHours) || ttlHours <= 0)
          return { kind: "error", message: "--ttl-hours must be a positive number" };
      }
      return {
        kind: "prefetch",
        input: flagValue(rest, "--config") ?? positional(scan),
        ...(vault !== undefined ? { vault } : {}),
        ...(ttlHours !== undefined ? { ttlHours } : {}),
      };
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
