// THE-518 — the config compiler's explain half: for every resolved value, WHERE it came from.
//
// The pipeline already had four layers and no way to see through them. A user asking "why is
// experiential logging on when my config file does not mention it" had to read the zod schema, the
// security-profile expander, and the env overlay list to find out — and the answer differs per key.
//
// PRECEDENCE, read off the code in load.ts rather than assumed:
//
//   env  >  file  >  profile  >  default        then post-processing ("derived")
//
// `finalizeConfig` writes the env overlays INTO the raw object before `applySecurityProfile` runs,
// and the profile expander only fills fields the raw object does not already carry — so an
// env-supplied value outranks the file, and both outrank the profile. Defaults come last, from zod.
//
// SECRETS ARE REPORTED WITHOUT BEING PRINTED. That is the point of tracing rather than dumping: the
// useful fact is "auth.jwtSecret came from env:OBSIDIAN_TC_JWT_SECRET", and the value itself is
// exactly what must not appear in a diagnostic a user will paste into an issue. Redaction reuses
// cli/args.ts's existing rules so this surface cannot drift from `config-show`'s.

import { isAbsolute } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { applyEnvOverlays, finalizeConfig } from "./load";
import { applySecurityProfile } from "./security-profile";

/** Where a resolved value came from. Ordered by precedence, highest first. */
export type ConfigSource = "env" | "file" | "profile" | "default" | "derived";

export interface ExplainedValue {
  /** Dotted leaf path, e.g. `retrieval.cache.ttlSeconds`. */
  path: string;
  /** The resolved value, redacted when the key names a secret. */
  value: unknown;
  source: ConfigSource;
  /** Which env var, which profile, or why it is derived — absent for file/default. */
  detail?: string;
  /** True when the value was withheld; the SOURCE is still reported. */
  redacted?: boolean;
}

export interface ConfigExplanation {
  entries: ExplainedValue[];
  counts: Record<ConfigSource, number>;
}

/**
 * The env overlays `finalizeConfig` applies, as (config path, env var) pairs. Hand-listed because
 * the overlay itself is hand-written in load.ts — and `config-explain-coverage.test.ts` asserts this
 * list matches the `process.env` reads in that file, so an overlay added there without a line here
 * fails the build rather than silently reporting "file" or "default" for an env-supplied value.
 */
export const ENV_OVERLAYS: ReadonlyArray<readonly [string, string]> = [
  ["auth.jwtSecret", "OBSIDIAN_TC_JWT_SECRET"],
  ["plur.endpoint", "OBSIDIAN_TC_PLUR_ENDPOINT"],
  ["plur.apiKey", "OBSIDIAN_TC_PLUR_TOKEN"],
];

// Same rules as cli/args.ts's redactConfig, kept as one regex pair so the two surfaces agree.
const SECRET_KEY = /secret|token|password|apikey|api_key|credential|jwt/i;
const CREDENTIAL_HEADER = /^authorization$/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) || CREDENTIAL_HEADER.test(key);
}

/** Leaf paths of a plain object. Arrays are LEAVES: a `vaults` list is one decision, not N. */
function leafPaths(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) out.set(prefix, value);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [p, leaf] of leafPaths(v, path)) out.set(p, leaf);
    } else {
      out.set(path, v);
    }
  }
  return out;
}

/**
 * Resolve a raw config exactly as `finalizeConfig` does, and attribute every resolved leaf.
 *
 * Takes the RAW file object rather than a path so the caller controls IO, and takes `env` so the
 * attribution is testable without mutating the process environment.
 */
export function explainConfig(
  rawFile: Record<string, unknown>,
  opts: { env?: Record<string, string | undefined> } = {},
): ConfigExplanation {
  const env = opts.env ?? process.env;

  // Layer 1: what the file itself said, before anything was overlaid onto it.
  const filePaths = leafPaths(rawFile);

  // Layer 2: which paths the env overlay actually supplies on THIS invocation.
  const envPaths = new Map<string, string>();
  for (const [path, varName] of ENV_OVERLAYS) {
    if (env[varName]) envPaths.set(path, varName);
  }

  // Layer 3: what the security profile adds. Applied to a file+env clone, exactly as load.ts does,
  // so a field the file already sets is correctly NOT attributed to the profile.
  const withEnv = structuredClone(rawFile);
  applyEnvOverlays(withEnv, env);
  const profileName = typeof rawFile.securityProfile === "string" ? rawFile.securityProfile : null;
  const profilePaths = leafPaths(applySecurityProfile(structuredClone(withEnv)));

  // Layer 4: the resolved config. Produced by finalizeConfig itself — the same function the server
  // boots with — so the report can never describe a resolution the runtime does not perform. The
  // pre-anchor value is read separately, because the home-anchoring step is the one transformation
  // that makes a resolved value unfindable in the file it came from.
  const preAnchorCacheDir = ServerConfigSchema.parse(
    applySecurityProfile(structuredClone(withEnv)),
  ).cacheDir;
  const resolved: ServerConfig = finalizeConfig(structuredClone(rawFile), env);

  const entries: ExplainedValue[] = [];
  for (const [path, value] of leafPaths(resolved)) {
    const key = path.slice(path.lastIndexOf(".") + 1);
    const secret = isSecretKey(key) && typeof value === "string" && value.length > 0;
    let source: ConfigSource;
    let detail: string | undefined;

    if (envPaths.has(path)) {
      source = "env";
      detail = envPaths.get(path);
    } else if (path === "cacheDir" && !isAbsolute(preAnchorCacheDir)) {
      // Checked BEFORE `file`: a file that sets a RELATIVE cacheDir still does not explain the
      // absolute path that comes out, so attributing it to the file would send the reader looking
      // for a value their config does not contain.
      // load.ts anchors a relative cacheDir to the home directory so a GUI launcher's CWD cannot
      // make it unwritable. That is neither the file's value nor the schema default.
      source = "derived";
      detail = `relative cacheDir "${preAnchorCacheDir}" anchored to the home directory`;
    } else if (filePaths.has(path)) {
      source = "file";
    } else if (profilePaths.has(path) && profileName) {
      source = "profile";
      detail = profileName;
    } else {
      source = "default";
    }

    entries.push({
      path,
      value: secret ? "<redacted>" : value,
      source,
      ...(detail !== undefined ? { detail } : {}),
      ...(secret ? { redacted: true } : {}),
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const counts: Record<ConfigSource, number> = {
    env: 0,
    file: 0,
    profile: 0,
    default: 0,
    derived: 0,
  };
  for (const e of entries) counts[e.source]++;
  return { entries, counts };
}

/**
 * Render a validation failure as one readable diagnostic instead of a zod dump.
 *
 * "Fails fast with a clear diagnostic" is a Done-when on THE-518, and the default zod error is a
 * JSON blob whose useful part (which key, what was wrong) is buried. One line per issue, deepest
 * path first, is what a user can act on.
 */
export function formatConfigError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path: Array<string | number>; message: string }> })
    ?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return err instanceof Error ? err.message : String(err);
  }
  const lines = issues.map((i) => {
    const p = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `  ${p}: ${i.message}`;
  });
  return `config is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}
