// THE-934 — `obsidian-tc consolidate --once [--dry-run]` argv parsing. Split out of args.ts for
// the same reason parse-import-ambient.ts documents: a new command's parse branch does not fit
// under biome's noExcessiveLinesPerFile floor on args.ts (CLAUDE.md). No dependency on args.ts
// (not even CliCommand), so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";

export interface ConsolidateCommand {
  kind: "consolidate";
  configPath?: string;
  /** Required today (Gate 2/3: CLI-only, no schedule mode) — `--once` names the one supported
   *  shape so a bare `consolidate` is a usage error rather than silently doing nothing. */
  once?: boolean;
  dryRun?: boolean;
}

/** Parse `consolidate --once [--dry-run] [--config <path>]`. */
export function parseConsolidate(rest: string[]): ConsolidateCommand {
  const scan = rest.filter((a) => a !== "--once" && a !== "--dry-run");
  const i = scan.indexOf("--config");
  if (i >= 0) scan.splice(i, 2);
  const flagValue = (name: string): string | undefined => {
    const idx = rest.indexOf(name);
    if (idx < 0) return undefined;
    const v = rest[idx + 1];
    if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
    return v;
  };
  const configPath = flagValue("--config") ?? scan.find((a) => !a.startsWith("-"));
  return {
    kind: "consolidate",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(rest.includes("--once") ? { once: true } : {}),
    ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
  };
}
