// `obsidian-tc contradiction-rejudge` argv parsing. Split out of args.ts for the same reason
// parse-consolidate.ts documents: a new command's parse branch does not fit under biome's
// noExcessiveLinesPerFile floor on args.ts (CLAUDE.md). No dependency on args.ts (not even
// CliCommand), so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";

export interface RejudgeCommand {
  kind: "contradiction-rejudge";
  input?: string;
  vault?: string;
  /** `--judge-model <stored value>`: only rows whose stored judge_model equals it. */
  judgeModel?: string;
  dryRun?: boolean;
  limit?: number;
  concurrency?: number;
  delayMs?: number;
}

/** Parse `contradiction-rejudge [path] [--dry-run] [--vault <id>] [--judge-model <m>] [--limit N]
 *  [--concurrency N] [--delay-ms N] [--config <path>]`. */
export function parseRejudge(rest: string[]): RejudgeCommand {
  const valueFlags = [
    "--vault",
    "--judge-model",
    "--limit",
    "--concurrency",
    "--delay-ms",
    "--config",
  ];
  const flagValue = (name: string): string | undefined => {
    const idx = rest.indexOf(name);
    if (idx < 0) return undefined;
    const v = rest[idx + 1];
    if (v === undefined || v.startsWith("-")) throw new CliError(`${name} requires a value`);
    return v;
  };
  const int = (name: string, min: number): number | undefined => {
    const v = flagValue(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) {
      throw new CliError(`${name} must be an integer >= ${min}`);
    }
    return n;
  };
  const scan = [...rest];
  for (const f of valueFlags) {
    const i = scan.indexOf(f);
    if (i >= 0) scan.splice(i, 2);
  }
  const input = flagValue("--config") ?? scan.find((a) => !a.startsWith("-"));
  const vault = flagValue("--vault");
  const judgeModel = flagValue("--judge-model");
  const limit = int("--limit", 0);
  const concurrency = int("--concurrency", 1);
  const delayMs = int("--delay-ms", 0);
  return {
    kind: "contradiction-rejudge",
    ...(input !== undefined ? { input } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(judgeModel !== undefined ? { judgeModel } : {}),
    ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
  };
}
