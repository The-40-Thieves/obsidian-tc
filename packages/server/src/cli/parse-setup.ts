// PR A of GH #995's two-part follow-up: `obsidian-tc setup` argv parsing, split out of args.ts for
// the same reason parse-telemetry.ts/parse-consolidate.ts document — a new command's parse branch
// does not fit under biome's noExcessiveLinesPerFile floor on args.ts. No dependency on args.ts
// (not even CliCommand), so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";
import { flagValue } from "./flag-value";

/** Every flag `setup` recognizes — value-taking and boolean alike. Fix-round finding 4: an
 *  argument that is neither one of these (nor that flag's `=value` form) nor a value already
 *  consumed by a value-taking flag must be a usage error, not silently ignored — a misspelled
 *  safety flag (`--dryrun` for `--dry-run`) must never be read as "flag absent" and fall through
 *  to a REAL write. */
const KNOWN_VALUE_FLAGS = ["--config", "--vault", "--install-client"];
const KNOWN_BOOLEAN_FLAGS = ["--yes", "--dry-run", "--force"];

/** PR B of GH #995's two-part follow-up: the MCP clients `setup --install-client` knows how to
 *  wire an `obsidian-tc` entry into — see cli/setup/client-install.ts for the per-client
 *  path/format/CLI logic (each entry's mechanism verified against that client's own current docs
 *  or `--help` output before being added; see that file's header). Extended with VS Code, opencode,
 *  Windsurf/Devin Desktop, Gemini CLI, Zed, Devin, and Aider (which has no MCP support at all — see
 *  cli/setup/client-install-editors.ts's own header for the split). */
export const INSTALL_CLIENTS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "chatgpt",
  "antigravity",
  "hermes",
  "vscode",
  "opencode",
  "windsurf",
  "gemini",
  "zed",
  "devin",
  "aider",
] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];

/** Aliases accepted on `--install-client` that resolve to one of `INSTALL_CLIENTS` above rather
 *  than being a client of their own — today just Windsurf's rebranded product name. Applied BEFORE
 *  validating against `INSTALL_CLIENTS`, so an unrecognized alias still gets the normal usage
 *  error. */
const INSTALL_CLIENT_ALIASES: Record<string, InstallClient> = {
  "devin-desktop": "windsurf",
};

export interface SetupCommand {
  kind: "setup";
  /** Where to write the config. Defaults (in cli/commands/setup.ts) to
   *  `~/.obsidian-tc/config.json` — a convention this command picks (matching the `cacheDir`
   *  default's own home-anchored name), NOT a path the loader itself defaults to: config/load.ts's
   *  loader only ever reads an explicit `--config`/positional path or `OBSIDIAN_TC_CONFIG` — see
   *  cli/commands/setup.ts's own header comment for why this matters for `serve` picking the
   *  written config back up. */
  configPath?: string;
  /** An explicit vault directory to detect from/add, in addition to whatever the local Obsidian
   *  registry already lists (capability/locate.ts's locateRegistry) — same escape hatch
   *  capability/profile.ts's own `extraVaultPaths` documents. */
  vaultPath?: string;
  /** Skip the interactive confirmation prompt and write immediately. */
  yes: boolean;
  /** Print the config that WOULD be written and exit — writes nothing. */
  dryRun: boolean;
  /** Overwrite an existing config at the target path (after backing it up) instead of refusing;
   *  ALSO reused by `--install-client` (PR B) to allow replacing an existing `obsidian-tc` entry
   *  in that client's own MCP config, rather than introduce a second `--force`-shaped flag. */
  force: boolean;
  /** PR B of GH #995's two-part follow-up: wire an `obsidian-tc` entry into one MCP client's own
   *  config INSTEAD of running setup's normal detect/decide/write flow. See
   *  cli/setup/client-install.ts. */
  installClient?: InstallClient;
}

/** No positional at all — unlike every other command here, `setup` takes only named flags. A bare
 *  positional would be ambiguous between "the config to write" (--config) and "the vault to detect
 *  from" (--vault), and the two must never be confused with each other. */
export function parseSetup(rest: string[]): SetupCommand {
  const configPath = flagValue(rest, "--config");
  const vaultPath = flagValue(rest, "--vault");
  const installClientRaw = flagValue(rest, "--install-client");
  // Finding 6 (MEDIUM, fix round 2): an empty `--config=`/`--vault=` value is defined (flagValue
  // only throws on a MISSING value), so it would otherwise flow straight through to `resolve("")`
  // downstream — which is cwd, silently. cwd may be anything a GUI launcher chose (Claude Desktop
  // starts MCP servers in C:\WINDOWS\system32 — see config/load.ts's own comment on this). Refuse
  // it here, before any I/O, the same way a missing value already is.
  if (configPath === "") throw new CliError("--config requires a non-empty value");
  if (vaultPath === "") throw new CliError("--vault requires a non-empty value");
  if (installClientRaw === "") throw new CliError("--install-client requires a non-empty value");
  const installClientNormalized =
    installClientRaw !== undefined
      ? (INSTALL_CLIENT_ALIASES[installClientRaw] ?? installClientRaw)
      : undefined;
  if (
    installClientNormalized !== undefined &&
    !(INSTALL_CLIENTS as readonly string[]).includes(installClientNormalized)
  ) {
    throw new CliError(
      `--install-client must be one of ${INSTALL_CLIENTS.join(", ")} (got "${installClientRaw}")`,
    );
  }
  const installClient = installClientNormalized as InstallClient | undefined;

  // Fix-round finding 4: reject anything unrecognized BEFORE returning a command this file's
  // caller (run_setup) will act on — a positional argument, or a flag/typo not in either known
  // list above, is a usage error, exactly like `--config` with no value already is (flagValue).
  const scan = [...rest];
  for (const f of KNOWN_VALUE_FLAGS) {
    let i = scan.indexOf(f);
    while (i >= 0) {
      scan.splice(i, 2);
      i = scan.indexOf(f);
    }
    // The `--flag=value` form: strip any token starting with `${f}=`.
    for (let j = scan.length - 1; j >= 0; j--) {
      if (scan[j]?.startsWith(`${f}=`)) scan.splice(j, 1);
    }
  }
  // Finding 1 (HIGH, fix round 2): boolean flags here have NO `--flag=value` form anywhere in this
  // CLI (`rest.includes(f)` below only ever matches a bare token — see e.g. parse-consolidate.ts's
  // own `--dry-run`). Stripping `--dry-run=true`/`--yes=true`/`--force=true` as "known" here, the
  // way the value-taking flags above legitimately are, would make them RECOGNIZED and then silently
  // read as false/absent by `rest.includes` — the exact "a safety flag looks recognized and still
  // lets a write through" class of bug finding 4's `--dryrun` typo fix already closed once. Only
  // the bare-token form is stripped; any `=` form is left in `scan` and becomes the same usage
  // error as a genuine typo.
  for (const f of KNOWN_BOOLEAN_FLAGS) {
    let i = scan.indexOf(f);
    while (i >= 0) {
      scan.splice(i, 1);
      i = scan.indexOf(f);
    }
  }
  if (scan.length > 0) {
    throw new CliError(
      `unknown argument to setup: ${scan[0]} (recognized: ${[...KNOWN_VALUE_FLAGS, ...KNOWN_BOOLEAN_FLAGS].join(", ")}; setup takes no positional arguments)`,
    );
  }

  return {
    kind: "setup",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(vaultPath !== undefined ? { vaultPath } : {}),
    ...(installClient !== undefined ? { installClient } : {}),
    yes: rest.includes("--yes"),
    dryRun: rest.includes("--dry-run"),
    force: rest.includes("--force"),
  };
}
