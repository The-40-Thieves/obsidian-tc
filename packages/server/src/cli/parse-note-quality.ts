// THE-537/THE-643 — `note-quality` argv parsing, split out of args.ts (GH #995 PR A) to make room
// under biome's noExcessiveLinesPerFile floor for the new `setup` command's own three lines
// (import + union member + dispatch branch) — args.ts was already sitting exactly at the 700-line
// ceiling with zero headroom. Same shape as parse-telemetry.ts/parse-compact.ts: no dependency on
// args.ts (not even CliCommand), so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";
import { flagValue, positional } from "./flag-value";

export interface NoteQualityCommand {
  kind: "note-quality";
  input?: string;
  vault?: string;
  flags?: string[];
  limit?: number;
  suggest?: boolean;
}

/** Recompute the note_quality rollup and print the flagged notes. THE-643 item 2: --suggest
 *  additionally prints a remediation line per flag. A boolean flag (no value token), so it is
 *  filtered out of `scan` by presence, not by the pair-splice loop below (mirrors --erase/--verify
 *  on `forget`). */
export function parseNoteQuality(rest: string[]): NoteQualityCommand {
  const scan = [...rest].filter((a) => a !== "--suggest");
  for (const f of ["--vault", "--flags", "--limit", "--config"]) {
    const i = scan.indexOf(f);
    if (i >= 0) scan.splice(i, 2);
  }
  const limitRaw = flagValue(rest, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new CliError("--limit must be a positive number");
  }
  const flagsRaw = flagValue(rest, "--flags");
  const flags = flagsRaw
    ?.split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const vault = flagValue(rest, "--vault");
  const suggest = rest.includes("--suggest");
  return {
    kind: "note-quality",
    input: flagValue(rest, "--config") ?? positional(scan),
    ...(vault !== undefined ? { vault } : {}),
    ...(flags && flags.length > 0 ? { flags } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(suggest ? { suggest } : {}),
  };
}
