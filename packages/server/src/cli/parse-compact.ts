// THE-1039 (GH #930) — `obsidian-tc compact` argv parsing. Split out of args.ts for the same
// reason parse-consolidate.ts documents: a new command's parse branch does not fit under biome's
// noExcessiveLinesPerFile floor on args.ts (CLAUDE.md). No dependency on args.ts (not even
// CliCommand), so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";

export interface CompactCommand {
  kind: "compact";
  input?: string;
  dryRun?: boolean;
  /** `--into <dir>`: VACUUM INTO a sibling copy under this directory instead of vacuuming the
   *  live file in place. See cli/commands/compact.ts for the full ruling. */
  into?: string;
  json?: string;
}

/** Parse `compact [path] [--dry-run] [--into <dir>] [--json <file>] [--config <path>]`. */
export function parseCompact(rest: string[]): CompactCommand {
  const flagValue = (name: string): string | undefined => {
    const idx = rest.indexOf(name);
    if (idx < 0) return undefined;
    const v = rest[idx + 1];
    if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
    return v;
  };
  const scan = [...rest];
  for (const f of ["--into", "--json", "--config"]) {
    const i = scan.indexOf(f);
    if (i >= 0) scan.splice(i, 2);
  }
  const into = flagValue("--into");
  const json = flagValue("--json");
  const input = flagValue("--config") ?? scan.find((a) => !a.startsWith("-"));
  // M5: the two are mutually exclusive and `--dry-run` silently won, so `--into` was ignored AND
  // the "needs ~2x free space" note was suppressed — an operator asking "what would --into do"
  // got a plain in-place dry run and no sign of it. Refused here rather than silently preferred.
  if (rest.includes("--dry-run") && into !== undefined) {
    throw new CliError("--dry-run and --into are mutually exclusive: --dry-run changes nothing");
  }
  return {
    kind: "compact",
    ...(input !== undefined ? { input } : {}),
    ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
    ...(into !== undefined ? { into } : {}),
    ...(json !== undefined ? { json } : {}),
  };
}
