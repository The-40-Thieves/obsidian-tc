// THE-650 — `obsidian-tc import-highlights` argv parsing. Split out of args.ts rather than
// inlined there (the pattern resolve-config.ts/redact-config.ts/usage.ts already establish) —
// args.ts sits at CLAUDE.md's noExcessiveLinesPerFile floor and a new command's parse branch does
// not fit under it. This file depends on nothing from args.ts (not even CliCommand — it defines
// its own return type, re-exported into args.ts's union), so importing it FROM args.ts creates no
// cycle — the same resolution cli-error.ts's header documents for CliError.
import { CliError } from "./cli-error";

export interface ImportHighlightsCommand {
  kind: "import-highlights";
  configPath?: string;
  vault?: string;
  /** ISO 8601. Passed through to the Readwise adapter's `updatedAfter`. */
  since?: string;
  dryRun?: boolean;
}

/** Parse `import-highlights [path] --vault <id> [--since <iso-date>] [--dry-run]`. */
export function parseImportHighlights(rest: string[]): ImportHighlightsCommand {
  const scan = rest.filter((a) => a !== "--dry-run");
  for (const f of ["--vault", "--since", "--config"]) {
    const i = scan.indexOf(f);
    if (i >= 0) scan.splice(i, 2);
  }
  const flagValue = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
    return v;
  };
  const vault = flagValue("--vault");
  const since = flagValue("--since");
  const configPath = flagValue("--config") ?? scan.find((a) => !a.startsWith("-"));
  return {
    kind: "import-highlights",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
  };
}
