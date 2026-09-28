// Split out of args.ts (THE-636) to stay under biome's noExcessiveLinesPerFile floor — see
// args.ts's re-export comments. Config-target resolution (vault dir vs config file vs
// OBSIDIAN_TC_CONFIG) has no coupling to argv parsing; it depends only on CliError (moved to
// ./cli-error.ts for the same reason, breaking what would otherwise be a circular import back
// into args.ts).
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import {
  finalizeConfig,
  isEmbeddingsProviderExplicit,
  isPlaneEnabledExplicit,
  readConfigFile,
} from "../config/load";
import { CliError } from "./cli-error";

/** `obsidian-tc setup`'s own CONVENTION for where to write a config when `--config` is not given
 *  (cli/commands/setup.ts's own header comment has the full "why" — the `cacheDir` schema
 *  default's own home-anchored name). Lives here, not in cli/commands/setup.ts, because
 *  `resolveServeConfigWithProvenance` below now needs the SAME path as its own last-resort
 *  fallback (fix round: `serve` never found `setup`'s output otherwise — see that function's own
 *  comment) — one definition, not two that could drift apart. */
export function defaultSetupConfigPath(): string {
  return join(homedir(), ".obsidian-tc", "config.json");
}

/** Build a single-vault config from a vault directory, applying every schema default.
 *
 *  THE-1122 review round 3: `cacheDir` is passed explicitly here (the SAME value
 *  server.schema.ts's own `.default(".obsidian-tc")` would have supplied) rather than left for
 *  the schema to backfill silently — finalizeConfig now requires an explicit cacheDir whenever
 *  `embeddings.provider` resolves to "local" (which it always does here: this IS the zero-config
 *  front door, and "local" is the schema default), and this is the one call site that constructs
 *  that raw object instead of reading a real config file an operator could have set it in. */
export function configFromVaultPath(dir: string): ServerConfig {
  return finalizeConfig({
    vaults: [{ id: "main", path: resolve(dir) }],
    cacheDir: ".obsidian-tc",
  });
}

// The MCPB manifest spec (anthropics/dxt MANIFEST.md) never documents what a host substitutes
// for an optional `${user_config.X}` left blank in `mcp_config.args` -- observed against
// `@anthropic-ai/mcpb@2.1.2`'s `getMcpConfigForManifest`, a blank `config_path` leaves the
// LITERAL, unresolved placeholder text in argv (mcpb/manifest.json's own `config_path` stays
// `required: true` specifically because of this; this is defense in depth, not the primary
// fix, for any other manifest/host that substitutes an empty string instead). Either shape must
// be treated the same as "no argument was given" -- never as a real path to `statSync` -- and
// fall through to `OBSIDIAN_TC_CONFIG` exactly as an absent CLI argument would.
const UNSUBSTITUTED_PLACEHOLDER_RE = /^\$\{user_config\.[^}]+\}$/;

/** True for an empty string or an unresolved `${user_config.X}` placeholder -- both mean the
 *  host gave nothing usable, not a real vault/config path. Exported (finding 6, fix round, cross-
 *  vendor review) so `cli/setup/first-run-fallback.ts`'s own `shouldAttemptFirstRunFallback` can
 *  apply the SAME "no usable input" rule this module's own `normalizeConfigPathInput` does --
 *  without duplicating the placeholder regex, and without that gate's own pure/no-I/O contract
 *  triggering `normalizeConfigPathInput`'s stderr side effect before the fallback has even decided
 *  whether it will run. */
export function isUnusableInput(value: string): boolean {
  return value === "" || UNSUBSTITUTED_PLACEHOLDER_RE.test(value);
}

/** Normalizes a raw CLI/positional input: an empty string or unresolved MCPB placeholder becomes
 *  `undefined` (with one stderr line so this is visible, not a silent swallow), so the caller
 *  falls through to `OBSIDIAN_TC_CONFIG` instead of treating placeholder text as a path. Exported
 *  so every caller that derives its OWN `configPath` from the same raw input (cli.ts's
 *  `run_serve`, which passes it separately into `buildServerRuntime` for the module-loader trust
 *  root) normalizes through this one function rather than re-deriving the same check. */
export function normalizeConfigPathInput(input: string | undefined): string | undefined {
  if (input === undefined || !isUnusableInput(input)) return input;
  process.stderr.write(
    `obsidian-tc: ignoring unsubstituted MCPB placeholder or empty config path (${JSON.stringify(input)}); falling back to OBSIDIAN_TC_CONFIG.\n`,
  );
  return undefined;
}

/** THE-825: a resolved serve config paired with whether `plane.enabled` was set explicitly in the
 *  raw file (as opposed to being absent and defaulted) — see `resolveServeConfigWithProvenance`. */
export interface ResolvedServeConfig {
  config: ServerConfig;
  planeEnabledExplicit: boolean;
  /** GH #995: whether the raw (pre-default) config explicitly set `embeddings.provider` — see
   *  config/load.ts's `isEmbeddingsProviderExplicit`. Zero-config (a vault directory) has no file,
   *  so is never explicit, same as `planeEnabledExplicit`. */
  embeddingsProviderExplicit: boolean;
  /** Fix round 2 (Codex review 1001-verify-r2, finding 7): the ACTUAL config file path this
   *  resolution used — including the `defaultSetupConfigPath()` last-resort fallback below —
   *  undefined for zero-config (a vault directory has no config file at all). `cli.ts`'s
   *  `run_serve` needs this exact value, not a second independent re-derivation of
   *  input/env/default, for the module-loader trust root (`buildServerRuntime`'s `configPath`):
   *  before this field existed, `run_serve` recomputed `configPath` from ONLY `cmd.input` and
   *  `OBSIDIAN_TC_CONFIG`, so a bare `obsidian-tc` relying on the default-file fallback loaded a
   *  real config (`config` above) while the module hatch's trust root stayed `undefined` — a
   *  config with `embeddings.modulePath` set (setup preserves keys it does not own, so a merged
   *  config CAN carry one) would then refuse to load its own module. One resolution, one path,
   *  used everywhere it matters — not two derivations that could drift apart. */
  configFilePath: string | undefined;
}

/**
 * Resolve a serve target, same rule as `resolveServeConfig` below, but also reports whether
 * `plane.enabled` was explicit in the raw file. Zero-config (a vault directory) has no file, so is
 * never explicit. The one substantive implementation — `resolveServeConfig` is a thin wrapper —
 * so the directory-vs-file resolution rule exists in exactly one place.
 */
export function resolveServeConfigWithProvenance(input?: string): ResolvedServeConfig {
  // `||`, not `??`: normalizeConfigPathInput already maps "" and an unresolved MCPB placeholder to
  // `undefined`, but `||` here is the second line of defense -- a defined-but-falsy `input` must
  // fall through to OBSIDIAN_TC_CONFIG rather than pin `target` to that falsy value and mask it
  // (the exact bug `??` had: `"" ?? env` returns "" because "" is not nullish).
  //
  // Fix round (Codex review 1001-verify, "default output is not auto-loaded"): `obsidian-tc
  // setup` writes to `defaultSetupConfigPath()` by convention, but this loader had no matching
  // fallback -- a bare `obsidian-tc` (no argument, no OBSIDIAN_TC_CONFIG) never found what setup
  // just wrote. This is the LAST resort, after both real inputs are exhausted, and only when that
  // exact file exists -- it changes nothing for zero-config (a vault directory) or an explicit
  // config/env, and does not fabricate a path that isn't actually there.
  const target =
    normalizeConfigPathInput(input) ||
    process.env.OBSIDIAN_TC_CONFIG ||
    (existsSync(defaultSetupConfigPath()) ? defaultSetupConfigPath() : undefined);
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
  if (stat.isDirectory()) {
    return {
      config: configFromVaultPath(target),
      planeEnabledExplicit: false,
      embeddingsProviderExplicit: false,
      configFilePath: undefined,
    };
  }
  // Finding 4 (fix round, cross-vendor review): "residual poison" — a crash between claiming the
  // default-path config's NAME and completing its content (cli/setup/write.ts's own "finding 1"
  // comment on `finalizeExclusiveCreate`) can leave an empty/unparseable file at EXACTLY the
  // convention path `obsidian-tc setup`'s first-run fallback writes to. A raw `JSON.parse`
  // `SyntaxError` there is useless to an operator who never passed `--config` at all and has no
  // idea that path is even in play. Scoped to the default-path fallback specifically (never an
  // operator's own EXPLICIT `--config`/positional/env target) — that failure's own parse error is
  // already meaningful, since the operator named the file themselves.
  let raw: Record<string, unknown>;
  try {
    raw = readConfigFile(target);
  } catch (e) {
    if (e instanceof SyntaxError && target === defaultSetupConfigPath()) {
      throw new CliError(
        `obsidian-tc: the config at ${target} could not be parsed as JSON (empty or ` +
          "corrupted) — this is the default path obsidian-tc's first-run fallback writes to, " +
          "and an interrupted write can leave it broken. Delete it and try again, or run " +
          "`obsidian-tc setup` to write a fresh one.\n",
      );
    }
    throw e;
  }
  return {
    config: finalizeConfig(raw),
    planeEnabledExplicit: isPlaneEnabledExplicit(raw),
    embeddingsProviderExplicit: isEmbeddingsProviderExplicit(raw),
    configFilePath: target,
  };
}

/**
 * Resolve a serve target. A directory boots zero-config (a single vault "main");
 * a file is loaded as a config; absent falls back to OBSIDIAN_TC_CONFIG.
 */
export function resolveServeConfig(input?: string): ServerConfig {
  return resolveServeConfigWithProvenance(input).config;
}
