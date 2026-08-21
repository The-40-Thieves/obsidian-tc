// THE-175 — `obsidian-tc import-ambient` argv parsing. Split out of args.ts rather than inlined
// there, the same reasoning THE-650's parse-import-highlights.ts documents (args.ts sits at
// CLAUDE.md's noExcessiveLinesPerFile floor — biome's 700-line cap — and a new command's parse
// branch does not fit under it). This file depends on nothing from args.ts (not even CliCommand —
// it defines its own return type, re-exported into args.ts's union), so importing it FROM args.ts
// creates no cycle — the same resolution cli-error.ts's header documents for CliError.
import { CliError } from "./cli-error";

export interface ImportAmbientCommand {
  kind: "import-ambient";
  configPath?: string;
  vault?: string;
  /** ISO 8601. Passed through to the Pensieve adapter's `since`. */
  since?: string;
  /** Which computer's Pensieve instance to label observations with. Absent falls back to the
   *  configured baseUrl's hostname — see cli/commands/import-ambient.ts. */
  machine?: string;
  dryRun?: boolean;
}

/** Parse `import-ambient [path] --vault <id> [--since <iso-date>] [--machine <label>] [--dry-run]`. */
export function parseImportAmbient(rest: string[]): ImportAmbientCommand {
  const scan = rest.filter((a) => a !== "--dry-run");
  for (const f of ["--vault", "--since", "--machine", "--config"]) {
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
  const machine = flagValue("--machine");
  const configPath = flagValue("--config") ?? scan.find((a) => !a.startsWith("-"));
  return {
    kind: "import-ambient",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(machine !== undefined ? { machine } : {}),
    ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
  };
}
