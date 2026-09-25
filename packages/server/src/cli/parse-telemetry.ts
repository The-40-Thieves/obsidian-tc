// THE-1125 — `obsidian-tc telemetry preview|status|reset-id` argv parsing. Split out of args.ts
// for the same reason parse-consolidate.ts documents: a new command's parse branch does not fit
// under biome's noExcessiveLinesPerFile floor on args.ts. No dependency on args.ts (not even
// CliCommand), so importing it FROM args.ts creates no cycle.
import { flagValue, positional } from "./flag-value";

export interface TelemetryCommand {
  kind: "telemetry";
  sub?: string;
  configPath?: string;
  json?: boolean;
  /** `preview` only: show the endpoint's path (never userinfo/query — those are refused at config
   *  load or dropped unconditionally). Default false — see redact-endpoint.ts. */
  showPath?: boolean;
}

const SUBCOMMANDS = ["preview", "status", "reset-id"];

/** Parse `telemetry <preview|status|reset-id> [path] [--json] [--show-path]`. Same two-word shape
 *  as `config <sub>`/`token mint`. */
export function parseTelemetry(
  rest: string[],
): TelemetryCommand | { kind: "error"; message: string } {
  const sub = rest[0];
  const scan = rest.slice(1).filter((a) => a !== "--json" && a !== "--show-path");
  const configPath = flagValue(rest, "--config") ?? positional(scan);
  if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
    return { kind: "error", message: `unknown telemetry subcommand: ${sub ?? "(none)"}` };
  }
  return {
    kind: "telemetry",
    sub,
    ...(configPath !== undefined ? { configPath } : {}),
    json: rest.includes("--json"),
    showPath: rest.includes("--show-path"),
  };
}
