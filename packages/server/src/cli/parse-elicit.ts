// THE-826 — `obsidian-tc elicit` argv parsing. Split out of args.ts for the same reason
// parse-compact.ts documents: the parse branch no longer fits under biome's noExcessiveLinesPerFile
// floor on args.ts. No dependency on args.ts, so importing it FROM args.ts creates no cycle.
import { CliError } from "./cli-error";
import { flagValue, positional } from "./flag-value";

/** `elicit` mints a single-use HITL confirmation token bound to an args_hash an elicit_required
 *  error returned — see cli/commands/elicit-mint.ts for the full design. No `ttl` field,
 *  deliberately: the mint always uses the server's configured elicitTtlSeconds. */
export interface ElicitMintCommand {
  kind: "elicit-mint";
  configPath?: string;
  hash?: string;
  tool?: string;
  vault?: string;
  caller?: string;
  /** The `state_fp` of the request being approved: binds the token to that request's state. */
  stateFp?: string;
  json?: boolean;
}

/**
 * Parse `elicit --hash <args_hash> --tool <name> [--vault <id>] [--caller <id>] [--state-fp <fp>]
 * [--config <path>] [--json]`. --hash and --tool are required and enforced HERE (not only in
 * planElicitMint) so a missing one exits 2 like every other usage error — the same duplication
 * `token mint`'s --sub check documents. No --ttl flag exists at all: the mint always uses the
 * server's configured elicitTtlSeconds, so this parser can never even OFFER a way to mint a
 * longer-lived token than the live server would issue.
 */
export function parseElicitMint(rest: string[]): ElicitMintCommand {
  const scan = [...rest];
  for (const f of ["--hash", "--tool", "--vault", "--caller", "--state-fp", "--config"]) {
    const i = scan.indexOf(f);
    if (i >= 0) scan.splice(i, 2);
  }
  const hash = flagValue(rest, "--hash");
  const tool = flagValue(rest, "--tool");
  const vault = flagValue(rest, "--vault");
  const caller = flagValue(rest, "--caller");
  const stateFp = flagValue(rest, "--state-fp");
  if (hash === undefined) {
    throw new CliError(
      "elicit requires --hash (the args_hash the elicit_required error's details carried)",
    );
  }
  if (tool === undefined) {
    throw new CliError("elicit requires --tool (the tool name the confirmation is for)");
  }
  const configPath = flagValue(rest, "--config") ?? positional(scan);
  return {
    kind: "elicit-mint",
    hash,
    tool,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(caller !== undefined ? { caller } : {}),
    ...(stateFp !== undefined ? { stateFp } : {}),
    json: rest.includes("--json"),
  };
}
