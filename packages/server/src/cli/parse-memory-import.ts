// THE-1124 — `obsidian-tc memory import` argv parsing, split out of args.ts the same way
// THE-175's parse-import-ambient.ts documents (args.ts sits at biome's noExcessiveLinesPerFile
// floor). No dependency on args.ts's CliCommand — this defines its own return type, re-exported
// into the union there, so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";
import { flagValue } from "./flag-value";

const ADAPTERS = ["basic-memory", "claude-code-memory"] as const;
export type MemoryImportAdapter = (typeof ADAPTERS)[number];

export interface MemoryImportCommand {
  kind: "memory-import";
  configPath?: string;
  vault?: string;
  from?: MemoryImportAdapter;
  /** The import directory, e.g. a basic-memory notes/ folder or a Claude Code memory checkout.
   *  Required — enforced in cli/commands/memory-import.ts alongside --vault/--from, the same
   *  "parser stays total, the command exits 2" split every sibling command here uses. */
  dir?: string;
  apply?: boolean;
}

/** Parse `memory import --from <adapter> <dir> [config-path] --vault <id> [--apply]`. The
 *  DIRECTORY is the first non-flag token (required, like context-import's bundle-path); an
 *  optional SECOND non-flag token is the config path — the same dual-positional shape
 *  context-import's own header documents. */
export function parseMemoryImport(rest: string[]): MemoryImportCommand {
  const scan = [...rest].filter((a) => a !== "--apply");
  for (const f of ["--from", "--vault", "--config"]) {
    const i = scan.indexOf(f);
    if (i >= 0) scan.splice(i, 2);
  }
  const positionals = scan.filter((a) => !a.startsWith("-"));
  const dir = positionals[0];
  const configPath = flagValue(rest, "--config") ?? positionals[1];
  const vault = flagValue(rest, "--vault");
  const fromRaw = flagValue(rest, "--from");
  if (fromRaw !== undefined && !(ADAPTERS as readonly string[]).includes(fromRaw)) {
    throw new CliError(`--from must be one of ${ADAPTERS.join("|")}, got: ${fromRaw}`);
  }
  const from = fromRaw as MemoryImportAdapter | undefined;
  return {
    kind: "memory-import",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(dir !== undefined ? { dir } : {}),
    ...(rest.includes("--apply") ? { apply: true } : {}),
  };
}
